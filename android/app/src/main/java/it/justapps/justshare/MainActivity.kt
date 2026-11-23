package it.justapps.justshare

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.nfc.tech.Ndef
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle

val Orange = Color(0xFFFF5A1F)

fun nearbyPermissions(): Array<String> = buildList {
    if (Build.VERSION.SDK_INT >= 31) {
        add(Manifest.permission.BLUETOOTH_SCAN)
        add(Manifest.permission.BLUETOOTH_ADVERTISE)
        add(Manifest.permission.BLUETOOTH_CONNECT)
    } else add(Manifest.permission.ACCESS_FINE_LOCATION)
    if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.NEARBY_WIFI_DEVICES)
    else if (Build.VERSION.SDK_INT >= 31) add(Manifest.permission.ACCESS_FINE_LOCATION)
}.toTypedArray()

fun hasPermissions(ctx: Context) = nearbyPermissions().all { ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED }

class MainActivity : ComponentActivity() {
    private var shared by mutableStateOf<List<Uri>>(emptyList())
    private var sharedText by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Share.init(this)
        readShare(intent)
        // Transfers need the app in front: keep the screen on while it's open.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            Theme {
                Screen(shared, sharedText) {
                    shared = emptyList()
                    sharedText = null
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        readShare(intent)
    }

    private fun readShare(i: Intent?) {
        when (i?.action) {
            Intent.ACTION_SEND -> {
                IntentCompat.getParcelableExtra(i, Intent.EXTRA_STREAM, Uri::class.java)?.let { shared = listOf(it) }
                i.getStringExtra(Intent.EXTRA_TEXT)?.let { if (shared.isEmpty()) sharedText = it }
            }
            Intent.ACTION_SEND_MULTIPLE ->
                IntentCompat.getParcelableArrayListExtra(i, Intent.EXTRA_STREAM, Uri::class.java)?.let { shared = it }
        }
    }

    private val nfc by lazy { NfcAdapter.getDefaultAdapter(this) }
    private val tapService by lazy { ComponentName(this, TapService::class.java) }

    override fun onResume() {
        super.onResume()
        // While JustShare is open, our tag wins over other apps using the same NFC AID.
        nfc?.let { runCatching { CardEmulation.getInstance(it).setPreferredService(this, tapService) } }
    }

    override fun onPause() {
        nfc?.let { runCatching { CardEmulation.getInstance(it).unsetPreferredService(this) } }
        super.onPause()
    }

    override fun onDestroy() {
        if (isFinishing) Share.stop()
        super.onDestroy()
    }
}

/** Reads the other phone (which acts as an NFC tag) and hands its token to Share. */
fun readTap(tag: android.nfc.Tag) {
    val ndef = Ndef.get(tag) ?: return Share.onTapUnknown()
    val msg = ndef.cachedNdefMessage ?: runCatching {
        ndef.connect()
        ndef.ndefMessage.also { ndef.close() }
    }.getOrNull()
    val rec = msg?.records?.firstOrNull { it.tnf == NdefRecord.TNF_EXTERNAL_TYPE && String(it.type) == Tap.TYPE }
    val parsed = rec?.let { Tap.parsePayload(it.payload) } ?: return Share.onTapUnknown()
    Share.onTapRead(parsed.first)
}

@Composable
fun Theme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors = if (dark) {
        darkColorScheme(
            primary = Orange, onPrimary = Color.White, background = Color(0xFF0F0F10), surface = Color(0xFF1C1C1E),
            onBackground = Color(0xFFF5F5F7), onSurface = Color(0xFFF5F5F7), onSurfaceVariant = Color(0xFFA1A1A6), surfaceVariant = Color(0xFF26262A),
        )
    } else {
        lightColorScheme(
            primary = Orange, onPrimary = Color.White, background = Color(0xFFF5F5F7), surface = Color.White,
            onBackground = Color(0xFF1D1D1F), onSurface = Color(0xFF1D1D1F), onSurfaceVariant = Color(0xFF6E6E73), surfaceVariant = Color(0xFFEDEDF0),
        )
    }
    MaterialTheme(colorScheme = colors, content = content)
}

private fun formatBytes(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "%.0f KB".format(n / 1024.0)
    n < 1024L * 1024 * 1024 -> "%.1f MB".format(n / 1048576.0)
    else -> "%.2f GB".format(n / 1073741824.0)
}

@Composable
fun Screen(shared: List<Uri>, sharedText: String?, onSharedConsumed: () -> Unit) {
    val ctx = LocalContext.current
    val st by Share.state.collectAsStateWithLifecycle()
    val prefs = remember { ctx.getSharedPreferences("justshare", Context.MODE_PRIVATE) }
    var name by remember { mutableStateOf(prefs.getString("name", null) ?: Build.MODEL) }
    var editing by remember { mutableStateOf(false) }
    var granted by remember { mutableStateOf(hasPermissions(ctx)) }
    var picked by remember { mutableStateOf<List<Uri>>(emptyList()) }
    var text by remember { mutableStateOf("") }
    val outgoing = shared.ifEmpty { picked }
    val outgoingText = sharedText ?: text.takeIf { it.isNotBlank() }

    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted = hasPermissions(ctx) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { picked = it }

    LaunchedEffect(granted, name) { if (granted) Share.start(name) }

    // NFC: with something selected this phone reads (touch the other phone to send);
    // otherwise it stays an NFC tag that other phones can read.
    val nfc = remember { NfcAdapter.getDefaultAdapter(ctx) }
    LaunchedEffect(outgoing, outgoingText) { Share.arm(outgoing, outgoingText) }
    LaunchedEffect(st.tapSent) {
        if (st.tapSent > 0) {
            picked = emptyList()
            text = ""
            onSharedConsumed()
        }
    }
    LifecycleResumeEffect(st.armed, granted) {
        val activity = ctx as Activity
        if (st.armed && granted && nfc?.isEnabled == true) {
            nfc.enableReaderMode(activity, ::readTap, NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B, null)
        }
        onPauseOrDispose { runCatching { nfc?.disableReaderMode(activity) } }
    }

    LazyColumn(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).safeDrawingPadding(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.ic_logo), null, Modifier.size(34.dp).clip(RoundedCornerShape(8.dp)))
                Spacer(Modifier.width(10.dp))
                Text("JustShare", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = MaterialTheme.colorScheme.onBackground)
            }
        }
        item {
            Column {
                Text(stringResource(R.string.hero_a), fontSize = 36.sp, lineHeight = 38.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onBackground)
                Text(stringResource(R.string.hero_b), fontSize = 36.sp, lineHeight = 38.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                Text(stringResource(R.string.lead), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.you), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(8.dp))
                    if (editing) {
                        OutlinedTextField(name, { name = it.take(40) }, singleLine = true, modifier = Modifier.weight(1f))
                        TextButton({ editing = false; prefs.edit().putString("name", name).apply(); Share.stop(); Share.start(name) }) { Text("OK", color = Orange) }
                    } else {
                        Box(
                            Modifier.clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surface).clickable { editing = true }
                                .padding(horizontal = 14.dp, vertical = 6.dp),
                        ) { Text("$name ✎", fontWeight = FontWeight.Bold) }
                    }
                }
            }
        }

        if (!granted) {
            item {
                Panel(highlight = true) {
                    Text(stringResource(R.string.perm_title), fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    Text(stringResource(R.string.perm_text), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp))
                    BigButton(stringResource(R.string.perm_button)) { permissions.launch(nearbyPermissions()) }
                }
            }
        } else {
            item {
                Panel {
                    Text(stringResource(R.string.what), fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    if (outgoing.isNotEmpty()) Text(stringResource(R.string.selected, outgoing.size), color = Orange, fontWeight = FontWeight.SemiBold)
                    if (sharedText != null) Text(sharedText.take(120), color = Orange)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.weight(1f)) { BigButton(stringResource(R.string.choose_files), primary = outgoing.isEmpty()) { picker.launch(arrayOf("*/*")) } }
                    }
                    if (sharedText == null) {
                        OutlinedTextField(text, { text = it }, label = { Text(stringResource(R.string.text_hint)) }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                    }
                }
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.nearby), fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onBackground)
                    Spacer(Modifier.width(10.dp))
                    if (st.advertising) Text("●", color = Color(0xFF30D158))
                }
                Text(
                    stringResource(if (outgoing.isEmpty() && outgoingText == null) R.string.tap_hint_empty else R.string.tap_hint),
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp,
                )
            }
            if (nfc != null) {
                item {
                    Panel(highlight = st.armed && nfc.isEnabled) {
                        Text("📲  " + stringResource(R.string.nfc_title), fontWeight = FontWeight.Bold)
                        Text(
                            stringResource(
                                when {
                                    !nfc.isEnabled -> R.string.nfc_off
                                    st.armed -> R.string.nfc_armed
                                    else -> R.string.nfc_idle
                                },
                            ),
                            color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp, modifier = Modifier.padding(top = 4.dp),
                        )
                        if (!nfc.isEnabled) {
                            TextButton({ runCatching { ctx.startActivity(Intent(android.provider.Settings.ACTION_NFC_SETTINGS)) } }) {
                                Text(stringResource(R.string.nfc_settings), color = Orange)
                            }
                        }
                    }
                }
            }
            if (st.endpoints.isEmpty()) {
                item { Panel { Text(stringResource(R.string.searching), color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) } }
            }
            items(st.endpoints, key = { it.id }) { e ->
                val enabled = outgoing.isNotEmpty() || outgoingText != null
                Card(
                    shape = RoundedCornerShape(22.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = if (enabled) BorderStroke(2.dp, Orange) else null,
                    modifier = Modifier.fillMaxWidth().clickable(enabled) {
                        Share.send(e.id, outgoing, outgoingText)
                        picked = emptyList()
                        text = ""
                        onSharedConsumed()
                    },
                ) {
                    Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("📱", fontSize = 26.sp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(e.name, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                            Text(
                                stringResource(if (e.id in st.connected) R.string.connected else R.string.nearby_device),
                                fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (enabled) Text(stringResource(R.string.send) + " →", color = Orange, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        if (st.items.isNotEmpty()) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.transfers), fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.weight(1f))
                    TextButton({ Share.clearFinished() }) { Text(stringResource(R.string.clear), color = MaterialTheme.colorScheme.onBackground) }
                }
            }
            items(st.items, key = { it.key }) { ItemCard(it) }
        }

        item {
            Panel {
                Text(stringResource(R.string.web_title), fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Text(stringResource(R.string.web_text), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp, modifier = Modifier.padding(vertical = 6.dp))
                OutlinedButton({ ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://share.justapps.it"))) }, shape = RoundedCornerShape(14.dp)) {
                    Text("share.justapps.it ↗", color = MaterialTheme.colorScheme.onSurface)
                }
            }
        }
        item { Text("JustApps · GPL-3.0", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(vertical = 12.dp)) }
    }

    st.pending?.let { p ->
        AlertDialog(
            onDismissRequest = {},
            title = { Text(if (p.incoming) stringResource(R.string.incoming, p.name) else stringResource(R.string.connecting_to, p.name)) },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.verify), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(p.digits, fontFamily = FontFamily.Monospace, fontSize = 36.sp, fontWeight = FontWeight.Bold, color = Orange)
                    Text(stringResource(R.string.verify_help), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp, textAlign = TextAlign.Center)
                }
            },
            confirmButton = { Button({ Share.accept(p.endpointId) }, colors = ButtonDefaults.buttonColors(containerColor = Orange)) { Text(stringResource(R.string.accept)) } },
            dismissButton = { TextButton({ Share.reject(p.endpointId) }) { Text(stringResource(R.string.decline)) } },
        )
    }
    st.error?.let { e ->
        AlertDialog(onDismissRequest = { Share.clearError() }, text = { Text(e) }, confirmButton = { TextButton({ Share.clearError() }) { Text("OK") } })
    }
}

@Composable
fun ItemCard(i: Item) {
    val ctx = LocalContext.current
    Panel(highlight = i.status == Status.TRANSFERRING) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (i.outgoing) "↑" else "↓", color = Orange, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(if (i.text != null) i.endpointName else "${i.name} · ${formatBytes(i.size)}", fontWeight = FontWeight.Bold, maxLines = 1)
                Text(
                    "${i.endpointName} · " + stringResource(
                        when (i.status) {
                            Status.CONNECTING, Status.WAITING -> R.string.waiting
                            Status.TRANSFERRING -> if (i.outgoing) R.string.sending else R.string.receiving
                            Status.DONE -> if (i.outgoing) R.string.sent else R.string.saved
                            Status.FAILED -> R.string.failed
                        },
                    ),
                    fontSize = 13.sp, color = if (i.status == Status.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (i.status == Status.TRANSFERRING && i.size > 0) {
            Spacer(Modifier.height(8.dp))
            LinearProgressIndicator({ (i.done.toFloat() / i.size).coerceIn(0f, 1f) }, Modifier.fillMaxWidth(), color = Orange)
        }
        i.text?.let { t ->
            Spacer(Modifier.height(8.dp))
            Text(t, fontFamily = FontFamily.Monospace, fontSize = 14.sp)
            TextButton({
                (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager)
                    .setPrimaryClip(android.content.ClipData.newPlainText("JustShare", t))
            }) { Text(stringResource(R.string.copy), color = Orange) }
        }
        i.savedUri?.let { uri ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                Button(
                    { ctx.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, ctx.contentResolver.getType(uri)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) },
                    shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Orange),
                ) { Text(stringResource(R.string.open)) }
                OutlinedButton(
                    {
                        val send = Intent(Intent.ACTION_SEND).setType(ctx.contentResolver.getType(uri)).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        ctx.startActivity(Intent.createChooser(send, null))
                    },
                    shape = RoundedCornerShape(12.dp),
                ) { Text("↗", color = MaterialTheme.colorScheme.onSurface) }
            }
        }
    }
}

@Composable
fun Panel(highlight: Boolean = false, content: @Composable () -> Unit) {
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = if (highlight) BorderStroke(2.dp, Orange) else null,
        modifier = Modifier.fillMaxWidth(),
    ) { Column(Modifier.padding(18.dp)) { content() } }
}

@Composable
fun BigButton(text: String, primary: Boolean = true, onClick: () -> Unit) {
    if (primary) {
        Button(onClick, Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp), colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Color.White)) {
            Text(text, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
    } else {
        OutlinedButton(onClick, Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp)) {
            Text(text, fontWeight = FontWeight.Bold, fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}
