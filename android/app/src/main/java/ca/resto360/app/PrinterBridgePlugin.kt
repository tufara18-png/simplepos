package ca.resto360.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket

/**
 * Direct LAN printing from the app itself. Android (unlike Safari/WKWebView) can open a raw
 * TCP socket, so on this platform Resto360 does not need the local server.mjs print bridge --
 * this plugin replicates its exact ESC/POS framing so a receipt looks identical printed via
 * either path.
 *
 * Same safety posture as server.mjs: printer IPs must be private/local by default, since this
 * is a raw socket write with no application-level protocol to validate the destination.
 */
@CapacitorPlugin(name = "PrinterBridge")
class PrinterBridgePlugin : Plugin() {

    companion object {
        private const val CONNECT_TIMEOUT_MS = 5000
        private const val READ_TIMEOUT_MS = 5000

        private val ESC_INIT = byteArrayOf(0x1B, 0x40) // ESC @ -- initialize printer
        private fun escFeed() = byteArrayOf(0x1B, 0x64, 0x04) // ESC d 4 -- feed 4 lines
        private fun gsCut() = byteArrayOf(0x1D, 0x56, 0x00) // GS V 0 -- partial cut

        // ESC p m t1 t2 -- standard drawer-kick pulse. Pin 2 (m=0) is the near-universal
        // default wiring on receipt-printer drawer ports; pin 5 (m=1) is the alternate.
        private fun drawerPulse(pin: Int) = byteArrayOf(0x1B, 0x70, if (pin == 1) 0x01 else 0x00, 0x19.toByte(), 0xFA.toByte())
    }

    private fun isPrivateIp(ip: String): Boolean {
        val addr = try { InetAddress.getByName(ip) } catch (e: Exception) { return false }
        val bytes = addr.address
        return when {
            addr.isLoopbackAddress -> true
            bytes.size == 4 -> {
                val a = bytes[0].toInt() and 0xFF
                val b = bytes[1].toInt() and 0xFF
                a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
            }
            bytes.size == 16 -> {
                val first = bytes[0].toInt() and 0xFF
                (first == 0xFC || first == 0xFD) || (bytes[0] == 0xFE.toByte() && (bytes[1].toInt() and 0xC0) == 0x80)
            }
            else -> false
        }
    }

    private fun requireReachableIp(call: PluginCall, ip: String, allowPublic: Boolean): Boolean {
        if (allowPublic) return true
        if (!isPrivateIp(ip)) {
            call.reject("Adresse imprimante non locale refusée: $ip")
            return false
        }
        return true
    }

    private fun writeAndClose(ip: String, port: Int, data: ByteArray) {
        Socket().use { socket ->
            socket.connect(java.net.InetSocketAddress(ip, port), CONNECT_TIMEOUT_MS)
            socket.soTimeout = READ_TIMEOUT_MS
            val out: OutputStream = socket.getOutputStream()
            out.write(data)
            out.flush()
        }
    }

    @PluginMethod
    fun printReceipt(call: PluginCall) {
        val ip = call.getString("ip") ?: return call.reject("ip requise")
        val port = call.getInt("port") ?: 9100
        val text = call.getString("text") ?: return call.reject("text requis")
        val cut = call.getBoolean("cut") ?: true
        val allowPublic = call.getBoolean("allowPublicIp") ?: false
        if (!requireReachableIp(call, ip, allowPublic)) return

        try {
            val body = (text + "\n").toByteArray(Charsets.UTF_8)
            val data = ESC_INIT + body + escFeed() + if (cut) gsCut() else ByteArray(0)
            writeAndClose(ip, port, data)
            call.resolve(JSObject().put("ok", true).put("ip", ip).put("port", port))
        } catch (e: Exception) {
            call.reject("Imprimante inaccessible: ${e.message}", e)
        }
    }

    @PluginMethod
    fun kickDrawer(call: PluginCall) {
        val ip = call.getString("ip") ?: return call.reject("ip requise")
        val port = call.getInt("port") ?: 9100
        val pin = call.getInt("pin") ?: 0
        val allowPublic = call.getBoolean("allowPublicIp") ?: false
        if (!requireReachableIp(call, ip, allowPublic)) return

        try {
            writeAndClose(ip, port, drawerPulse(pin))
            call.resolve(JSObject().put("ok", true))
        } catch (e: Exception) {
            call.reject("Tiroir-caisse inaccessible: ${e.message}", e)
        }
    }
}
