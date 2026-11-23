package it.justapps.justshare

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONObject

/** Metadata sent (as a BYTES payload) before each FILE payload. */
data class Meta(val payloadId: Long, val name: String, val size: Long, val mime: String) {
    fun toJson(): String = JSONObject().put("t", "file").put("id", payloadId).put("name", name).put("size", size).put("mime", mime).toString()

    companion object {
        fun parse(s: String): Meta? = runCatching {
            val j = JSONObject(s)
            if (j.optString("t") != "file") null else Meta(j.getLong("id"), safeName(j.getString("name")), j.getLong("size"), j.optString("mime", "application/octet-stream"))
        }.getOrNull()

        /** No paths, no control characters, never empty. */
        fun safeName(name: String): String =
            name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\p{Cntrl}:*?\"<>|]"), "_").trim().take(120).ifEmpty { "file" }
    }
}

fun textMessage(text: String): String = JSONObject().put("t", "text").put("text", text).toString()
fun parseText(s: String): String? = runCatching { JSONObject(s).takeIf { it.optString("t") == "text" }?.getString("text") }.getOrNull()

data class Endpoint(val id: String, val name: String)

data class PendingConnection(val endpointId: String, val name: String, val digits: String, val incoming: Boolean)

enum class Status { CONNECTING, WAITING, TRANSFERRING, DONE, FAILED }

data class Item(
    val key: Long,
    val endpointName: String,
    val outgoing: Boolean,
    val name: String,
    val size: Long,
    val done: Long = 0,
    val status: Status = Status.WAITING,
    val savedUri: Uri? = null,
    val text: String? = null,
)

data class UiState(
    val advertising: Boolean = false,
    val endpoints: List<Endpoint> = emptyList(),
    val pending: PendingConnection? = null,
    val connected: Set<String> = emptySet(),
    val items: List<Item> = emptyList(),
    val error: String? = null,
)

/**
 * Nearby Connections: devices advertise and discover each other over
 * Bluetooth/BLE and move data over Wi-Fi Direct or a local hotspot when
 * available. Works with no internet. Connections are authenticated (UKEY2)
 * and encrypted; both screens show the same code before accepting.
 */
object Share {
    private const val SERVICE_ID = "it.justapps.justshare"
    private val strategy = Strategy.P2P_CLUSTER

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    private lateinit var app: Context
    private lateinit var client: ConnectionsClient
    private var myName = ""
    private val names = HashMap<String, String>()
    /** Files waiting for a connection to finish, per endpoint. */
    private val outbox = HashMap<String, Pair<List<Uri>, String?>>()
    private val incomingMeta = HashMap<Long, Meta>()
    private val incomingFiles = HashMap<Long, Payload>()

    fun init(ctx: Context) {
        if (::client.isInitialized) return
        app = ctx.applicationContext
        client = Nearby.getConnectionsClient(app)
    }

    fun start(name: String) {
        myName = name
        if (_state.value.advertising) return
        client.startAdvertising(name, SERVICE_ID, lifecycle, AdvertisingOptions.Builder().setStrategy(strategy).build())
            .addOnSuccessListener { _state.update { it.copy(advertising = true, error = null) } }
            .addOnFailureListener { e -> if (!e.isAlreadyRunning()) _state.update { it.copy(error = e.message) } }
        client.startDiscovery(SERVICE_ID, discovery, DiscoveryOptions.Builder().setStrategy(strategy).build())
            .addOnFailureListener { e -> if (!e.isAlreadyRunning()) _state.update { it.copy(error = e.message) } }
    }

    fun stop() {
        client.stopAdvertising()
        client.stopDiscovery()
        _state.update { it.copy(advertising = false, endpoints = emptyList()) }
    }

    private fun Exception.isAlreadyRunning() =
        (this as? com.google.android.gms.common.api.ApiException)?.statusCode.let {
            it == ConnectionsStatusCodes.STATUS_ALREADY_ADVERTISING || it == ConnectionsStatusCodes.STATUS_ALREADY_DISCOVERING
        }

    private val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            names[endpointId] = info.endpointName
            _state.update { s -> s.copy(endpoints = (s.endpoints.filter { it.id != endpointId } + Endpoint(endpointId, info.endpointName)).sortedBy { it.name }) }
        }

        override fun onEndpointLost(endpointId: String) {
            _state.update { s -> s.copy(endpoints = s.endpoints.filter { it.id != endpointId }) }
        }
    }

    /** Sends files and/or text: connects first if needed. */
    fun send(endpointId: String, uris: List<Uri>, text: String?) {
        if (endpointId in _state.value.connected) {
            transmit(endpointId, uris, text)
            return
        }
        outbox[endpointId] = uris to text
        client.requestConnection(myName, endpointId, lifecycle)
            .addOnFailureListener { e -> _state.update { it.copy(error = e.message) } }
    }

    fun accept(endpointId: String) {
        client.acceptConnection(endpointId, payloads)
        _state.update { it.copy(pending = null) }
    }

    fun reject(endpointId: String) {
        client.rejectConnection(endpointId)
        outbox.remove(endpointId)
        _state.update { it.copy(pending = null) }
    }

    private val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            names[endpointId] = info.endpointName
            // Both sides must confirm the same code (protects against a device in the middle).
            _state.update { it.copy(pending = PendingConnection(endpointId, info.endpointName, info.authenticationDigits, info.isIncomingConnection)) }
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            if (result.status.statusCode == ConnectionsStatusCodes.STATUS_OK) {
                _state.update { it.copy(connected = it.connected + endpointId) }
                outbox.remove(endpointId)?.let { (uris, text) -> transmit(endpointId, uris, text) }
            } else {
                outbox.remove(endpointId)
                _state.update { it.copy(error = app.getString(R.string.rejected, names[endpointId] ?: "")) }
            }
        }

        override fun onDisconnected(endpointId: String) {
            _state.update { s ->
                s.copy(
                    connected = s.connected - endpointId,
                    items = s.items.map { if (it.endpointName == names[endpointId] && it.status != Status.DONE) it.copy(status = Status.FAILED) else it },
                )
            }
        }
    }

    private fun transmit(endpointId: String, uris: List<Uri>, text: String?) {
        val who = names[endpointId] ?: "?"
        if (!text.isNullOrBlank()) {
            client.sendPayload(endpointId, Payload.fromBytes(textMessage(text).toByteArray()))
            addItem(Item(System.nanoTime(), who, true, "text", text.length.toLong(), text.length.toLong(), Status.DONE, text = text))
        }
        for (uri in uris) {
            val (name, size) = describe(uri)
            val pfd = app.contentResolver.openFileDescriptor(uri, "r") ?: continue
            val payload = Payload.fromFile(pfd)
            val meta = Meta(payload.id, name, size, app.contentResolver.getType(uri) ?: "application/octet-stream")
            client.sendPayload(endpointId, Payload.fromBytes(meta.toJson().toByteArray()))
            client.sendPayload(endpointId, payload)
            addItem(Item(payload.id, who, true, name, size, status = Status.TRANSFERRING))
        }
    }

    private fun describe(uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment ?: "file"
        var size = 0L
        app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = c.getString(0) ?: name
                size = c.getLong(1)
            }
        }
        return Meta.safeName(name) to size
    }

    private fun addItem(item: Item) = _state.update { it.copy(items = listOf(item) + it.items) }
    private fun updateItem(key: Long, f: (Item) -> Item) = _state.update { s -> s.copy(items = s.items.map { if (it.key == key) f(it) else it }) }

    private val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            val who = names[endpointId] ?: "?"
            when (payload.type) {
                Payload.Type.BYTES -> {
                    val s = String(payload.asBytes()!!)
                    Meta.parse(s)?.let { meta ->
                        incomingMeta[meta.payloadId] = meta
                        addItem(Item(meta.payloadId, who, false, meta.name, meta.size, status = Status.TRANSFERRING))
                    }
                    parseText(s)?.let { text -> addItem(Item(System.nanoTime(), who, false, "text", text.length.toLong(), text.length.toLong(), Status.DONE, text = text)) }
                }
                Payload.Type.FILE -> incomingFiles[payload.id] = payload
                else -> {}
            }
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            val id = update.payloadId
            when (update.status) {
                PayloadTransferUpdate.Status.IN_PROGRESS -> updateItem(id) { it.copy(done = update.bytesTransferred, status = Status.TRANSFERRING) }
                PayloadTransferUpdate.Status.SUCCESS -> {
                    val file = incomingFiles.remove(id)
                    val meta = incomingMeta.remove(id)
                    if (file != null && meta != null) {
                        val saved = runCatching { saveToDownloads(file, meta) }.getOrNull()
                        updateItem(id) { it.copy(done = it.size, status = if (saved != null) Status.DONE else Status.FAILED, savedUri = saved) }
                    } else updateItem(id) { it.copy(done = it.size, status = Status.DONE) }
                }
                PayloadTransferUpdate.Status.FAILURE, PayloadTransferUpdate.Status.CANCELED -> {
                    incomingFiles.remove(id)?.asFile()?.close()
                    incomingMeta.remove(id)
                    updateItem(id) { it.copy(status = Status.FAILED) }
                }
            }
        }
    }

    /** Moves a received file to Downloads/JustShare. */
    private fun saveToDownloads(payload: Payload, meta: Meta): Uri {
        val src = payload.asFile()!!.asUri()!!
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, meta.name)
            put(MediaStore.Downloads.MIME_TYPE, meta.mime)
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/JustShare")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = app.contentResolver
        val dest = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("downloads")
        resolver.openInputStream(src)!!.use { input -> resolver.openOutputStream(dest)!!.use { input.copyTo(it) } }
        resolver.update(dest, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        runCatching { resolver.delete(src, null, null) }
        return dest
    }

    fun clearError() = _state.update { it.copy(error = null) }
    fun clearFinished() = _state.update { s -> s.copy(items = s.items.filter { it.status == Status.TRANSFERRING || it.status == Status.WAITING }) }
}
