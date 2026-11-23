package it.justapps.justshare

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TapTest {
    private fun apdu(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }
    private fun ok(r: ByteArray) = assertArrayEquals(Type4Tag.SW_OK, r.copyOfRange(r.size - 2, r.size))

    /** Reads the NDEF file like Android's NFC stack does, in MLe-sized chunks. */
    private fun readAll(tag: Type4Tag): ByteArray {
        ok(tag.process(apdu(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)))
        ok(tag.process(apdu(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x03)))
        val cc = tag.process(apdu(0x00, 0xB0, 0x00, 0x00, 0x0F))
        ok(cc)
        assertEquals(17, cc.size)
        val mle = ((cc[3].toInt() and 0xff) shl 8) or (cc[4].toInt() and 0xff)
        ok(tag.process(apdu(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)))
        val nlen = tag.process(apdu(0x00, 0xB0, 0x00, 0x00, 0x02))
        val len = ((nlen[0].toInt() and 0xff) shl 8) or (nlen[1].toInt() and 0xff)
        var out = ByteArray(0)
        var off = 2
        while (out.size < len) {
            val n = minOf(mle, len - out.size)
            val r = tag.process(apdu(0x00, 0xB0, off shr 8, off and 0xff, n))
            ok(r)
            out += r.copyOfRange(0, r.size - 2)
            off += n
        }
        return out
    }

    @Test fun tagServesNdefMessage() {
        val msg = Tap.ndefMessage("abc123", "Pixel 9")
        assertArrayEquals(msg, readAll(Type4Tag { msg }))
    }

    @Test fun rejectsOtherApps() {
        val tag = Type4Tag { ByteArray(0) }
        assertArrayEquals(Type4Tag.SW_NOT_FOUND, tag.process(apdu(0x00, 0xA4, 0x04, 0x00, 0x07, 0xA0, 0, 0, 0, 0x03, 0x10, 0x10)))
        // Files can't be selected before the NDEF application.
        assertArrayEquals(Type4Tag.SW_NOT_FOUND, tag.process(apdu(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)))
    }

    @Test fun ndefRecordsParse() {
        val m = Tap.ndefMessage("tok", "Anna")
        // Record 1: well-known URI, MB set.
        assertEquals(0x91, m[0].toInt() and 0xff)
        assertEquals('U'.code, m[3].toInt())
        assertEquals(0x04, m[4].toInt())
        val uriLen = m[2].toInt()
        val r2 = 3 + 1 + uriLen
        assertEquals(0x54, m[r2].toInt() and 0xff) // ME | SR | TNF external
        val typeLen = m[r2 + 1].toInt()
        val payLen = m[r2 + 2].toInt()
        assertEquals(Tap.TYPE, String(m, r2 + 3, typeLen))
        val payload = m.copyOfRange(r2 + 3 + typeLen, r2 + 3 + typeLen + payLen)
        assertEquals("tok" to "Anna", Tap.parsePayload(payload))
        assertEquals(m.size, r2 + 3 + typeLen + payLen)
    }

    @Test fun namesCarryHashOrToken() {
        val t = Tap.newToken()
        assertEquals(32, t.length)
        val adv = Tap.parse(Tap.advertised("Pixel 9", t))
        assertEquals("Pixel 9", adv.name)
        assertEquals(Tap.hash(t), adv.hash)
        assertNull(adv.token)
        val req = Tap.parse(Tap.requesting("Anna", t))
        assertEquals(t, req.token)
        assertNull(req.hash)
        // Older app versions advertise just the name.
        assertEquals(Tap.Parsed("Old phone", null, null), Tap.parse("Old phone"))
    }
}
