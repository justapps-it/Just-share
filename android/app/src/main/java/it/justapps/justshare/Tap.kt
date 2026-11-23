package it.justapps.justshare

import java.security.MessageDigest
import java.security.SecureRandom

/**
 * NFC "tap to send".
 *
 * NFC moves far too little data for files, so (like Android Beam and Quick
 * Share) it is only used to pick the right phone: the receiving phone acts as
 * an NFC tag (Host Card Emulation, NFC Forum Type 4 tag) holding a one-time
 * token, the sending phone reads it, finds the phone that advertises the
 * matching hash over Nearby and connects. Files then travel over
 * Wi-Fi Direct / Bluetooth as usual. The tap itself is the consent, so no
 * code has to be confirmed. The token is rotated after every use and only
 * its hash is ever broadcast.
 */
object Tap {
    const val SEP = '\u001f'
    const val TYPE = "justapps.it:share"
    /** Phones without the app open the download page instead. */
    const val URL = "share.justapps.it/#android"

    fun newToken(): String = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    fun hash(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).take(5).joinToString("") { "%02x".format(it) }

    /** Name advertised over Nearby: "Pixel 9␟h:abcdef0123". */
    fun advertised(name: String, token: String) = "${name.take(32)}${SEP}h:${hash(token)}"

    /** Name sent with a connection request started by a tap: "Pixel 9␟t:<token>". */
    fun requesting(name: String, token: String) = "${name.take(32)}${SEP}t:$token"

    data class Parsed(val name: String, val hash: String?, val token: String?)

    fun parse(endpointName: String): Parsed {
        val name = endpointName.substringBefore(SEP)
        val extra = endpointName.substringAfter(SEP, "")
        return Parsed(name, extra.removePrefix("h:").takeIf { extra.startsWith("h:") }, extra.removePrefix("t:").takeIf { extra.startsWith("t:") })
    }

    /** Payload of the JustShare NFC record. */
    fun recordPayload(token: String?, name: String) = "${token.orEmpty()}$SEP${name.take(32)}".toByteArray()

    fun parsePayload(b: ByteArray): Pair<String, String>? {
        val s = String(b)
        if (SEP !in s) return null
        return s.substringBefore(SEP) to s.substringAfter(SEP)
    }

    /** NDEF message: a URL record first (for phones without the app), then ours. */
    fun ndefMessage(token: String?, name: String): ByteArray {
        val url = byteArrayOf(0x04) + URL.toByteArray() // 0x04 = "https://"
        return record(first = true, last = false, tnf = 0x01, type = "U".toByteArray(), payload = url) +
            record(first = false, last = true, tnf = 0x04, type = TYPE.toByteArray(), payload = recordPayload(token, name))
    }

    private fun record(first: Boolean, last: Boolean, tnf: Int, type: ByteArray, payload: ByteArray): ByteArray {
        require(payload.size < 256 && type.size < 256)
        var header = 0x10 or tnf // SR (short record)
        if (first) header = header or 0x80
        if (last) header = header or 0x40
        return byteArrayOf(header.toByte(), type.size.toByte(), payload.size.toByte()) + type + payload
    }
}

/**
 * Minimal read-only NFC Forum Type 4 tag (what NFC readers, including other
 * Android phones, read as a normal NDEF tag).
 */
class Type4Tag(private val message: () -> ByteArray) {
    private enum class File { NONE, CC, NDEF }

    private var selected = File.NONE
    private var appSelected = false
    private var ndef = ByteArray(0)

    fun reset() {
        selected = File.NONE
        appSelected = false
    }

    fun process(apdu: ByteArray): ByteArray {
        if (apdu.size < 4) return SW_WRONG_LENGTH
        val ins = apdu[1].toInt() and 0xff
        val p1 = apdu[2].toInt() and 0xff
        val p2 = apdu[3].toInt() and 0xff
        return when (ins) {
            0xA4 -> select(apdu, p1)
            0xB0 -> read(apdu, (p1 shl 8) or p2)
            else -> SW_INS_NOT_SUPPORTED
        }
    }

    private fun select(apdu: ByteArray, p1: Int): ByteArray {
        if (apdu.size < 5) return SW_WRONG_LENGTH
        val lc = apdu[4].toInt() and 0xff
        if (apdu.size < 5 + lc) return SW_WRONG_LENGTH
        val data = apdu.copyOfRange(5, 5 + lc)
        if (p1 == 0x04) {
            if (!data.contentEquals(NDEF_AID)) return SW_NOT_FOUND
            appSelected = true
            selected = File.NONE
            // Fresh snapshot for every read session.
            ndef = message().let { m -> byteArrayOf((m.size shr 8).toByte(), m.size.toByte()) + m }
            return SW_OK
        }
        if (!appSelected || p1 != 0x00 || lc != 2) return SW_NOT_FOUND
        selected = when {
            data[0] == 0xE1.toByte() && data[1] == 0x03.toByte() -> File.CC
            data[0] == 0xE1.toByte() && data[1] == 0x04.toByte() -> File.NDEF
            else -> return SW_NOT_FOUND
        }
        return SW_OK
    }

    private fun read(apdu: ByteArray, offset: Int): ByteArray {
        val file = when (selected) {
            File.CC -> CC
            File.NDEF -> ndef
            File.NONE -> return SW_NOT_FOUND
        }
        if (offset > file.size) return SW_WRONG_OFFSET
        var le = if (apdu.size >= 5) apdu[4].toInt() and 0xff else 0
        if (le == 0) le = 256
        val end = minOf(file.size, offset + le)
        return file.copyOfRange(offset, end) + SW_OK
    }

    companion object {
        val NDEF_AID = byteArrayOf(0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01)
        val SW_OK = byteArrayOf(0x90.toByte(), 0x00)
        val SW_NOT_FOUND = byteArrayOf(0x6A, 0x82.toByte())
        val SW_WRONG_LENGTH = byteArrayOf(0x67, 0x00)
        val SW_WRONG_OFFSET = byteArrayOf(0x6B, 0x00)
        val SW_INS_NOT_SUPPORTED = byteArrayOf(0x6D, 0x00)

        /** Capability container: v2.0, MLe 0x3B, MLc 0x34, NDEF file E104 up to 1 KB, read-only. */
        val CC = byteArrayOf(
            0x00, 0x0F, 0x20, 0x00, 0x3B, 0x00, 0x34,
            0x04, 0x06, 0xE1.toByte(), 0x04, 0x04, 0x00, 0x00, 0xFF.toByte(),
        )
    }
}
