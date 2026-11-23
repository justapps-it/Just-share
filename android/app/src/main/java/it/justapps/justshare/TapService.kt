package it.justapps.justshare

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/** Makes this phone readable as an NFC tag while JustShare is open. */
class TapService : HostApduService() {
    private val tag = Type4Tag { Share.tapMessage() }

    override fun processCommandApdu(commandApdu: ByteArray, extras: Bundle?): ByteArray = tag.process(commandApdu)

    override fun onDeactivated(reason: Int) = tag.reset()
}
