package it.justapps.justshare

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MetaTest {
    @Test fun roundTrip() {
        val m = Meta(42L, "foto vacanze.jpg", 123456L, "image/jpeg")
        assertEquals(m, Meta.parse(m.toJson()))
    }

    @Test fun namesCannotEscapeTheFolder() {
        assertEquals("passwd", Meta.safeName("../../etc/passwd"))
        assertEquals("evil_.txt", Meta.safeName("C:\\x\\evil:.txt"))
        assertEquals("file", Meta.safeName("   "))
    }

    @Test fun textMessages() {
        assertEquals("ciao", parseText(textMessage("ciao")))
        assertNull(parseText(Meta(1, "a", 1, "x").toJson()))
        assertNull(Meta.parse(textMessage("ciao")))
    }
}
