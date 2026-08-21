package ca.simplepos.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayInputStream
import java.io.OutputStreamWriter
import java.net.Socket
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager

/**
 * Sends the MEV-WEB request itself, from the device, instead of through a Supabase Edge
 * Function relay. Confirmed live (2026-08-21) that Deno's fetch() drops the IDVERSI header en
 * route to Revenu Québec's DEV "enrolement" endpoint for reasons still unexplained, while the
 * exact same headers sent via curl or Node's https module arrive intact -- so the request goes
 * out through Android's own network stack (HttpsURLConnection), a different, unrelated HTTP
 * client, rather than trying to work around a bug in a runtime this app does not otherwise use.
 *
 * Also confirmed live (same date): the "/transaction" endpoint is behind mutual TLS -- an
 * Azure Application Gateway rejects the handshake itself ("No required SSL certificate was
 * sent") before any application-layer field is ever read, unless the client presents its own
 * certificate during the TLS handshake. That certificate is the one Revenu Québec issued back
 * from the "certificats" enrolment step (mev_devices.certificate_pem), never the throwaway
 * self-signed placeholder AndroidKeyStore attaches to a freshly generated key pair.
 *
 * keyAlias/certificatePem are OPTIONAL, not mandatory: the very first "certificats" enrolment
 * call (AJO, brand-new device) happens before any certificate has ever been issued, so there
 * is nothing to present yet -- confirmed live that this call works over plain TLS. Only
 * "/transaction" traffic (always gated on an already-active certificate before this plugin is
 * ever called -- see mev-live.js) supplies both and gets the mTLS path below.
 *
 * Restricted to Revenu Québec's own domain: this plugin is not a general-purpose CORS bypass,
 * even though that would technically work for any host.
 */
@CapacitorPlugin(name = "MevProtocol")
class MevProtocolPlugin : Plugin() {

    companion object {
        private const val ALLOWED_HOST_SUFFIX = ".rq-fo.ca"
        private const val CONNECT_TIMEOUT_MS = 15000
        private const val READ_TIMEOUT_MS = 20000
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
    }

    /**
     * Presents a single fixed identity (the device's own AndroidKeyStore private key, paired
     * with the certificate Revenu Québec issued for it) for every alias/issuer the server asks
     * for -- there is only ever one client identity per device, so no real alias negotiation
     * is needed.
     */
    private class DeviceKeyManager(
        private val alias: String,
        private val privateKey: PrivateKey,
        private val certChain: Array<X509Certificate>,
    ) : X509ExtendedKeyManager() {
        override fun getClientAliases(keyType: String?, issuers: Array<Principal>?): Array<String> = arrayOf(alias)
        override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String = alias
        override fun chooseEngineClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?): String = alias
        override fun getServerAliases(keyType: String?, issuers: Array<Principal>?): Array<String>? = null
        override fun chooseServerAlias(keyType: String?, issuers: Array<Principal>?, socket: Socket?): String? = null
        override fun getCertificateChain(alias: String?): Array<X509Certificate> = certChain
        override fun getPrivateKey(alias: String?): PrivateKey = privateKey
    }

    @PluginMethod
    fun sendRequest(call: PluginCall) {
        val urlString = call.getString("url") ?: return call.reject("url requis")
        val body = call.getString("body") ?: return call.reject("body requis")
        val headersObj = call.getObject("headers") ?: JSObject()
        val keyAlias = call.getString("keyAlias")
        val certificatePem = call.getString("certificatePem")
        if ((keyAlias == null) != (certificatePem == null)) {
            return call.reject("keyAlias et certificatePem doivent être fournis ensemble ou omis ensemble")
        }

        val url = try { URL(urlString) } catch (e: Exception) { return call.reject("URL invalide: ${e.message}") }
        if (url.protocol != "https") return call.reject("HTTPS requis")
        if (!url.host.endsWith(ALLOWED_HOST_SUFFIX) && url.host != "rq-fo.ca") {
            return call.reject("Domaine non autorisé: ${url.host}")
        }

        var connection: HttpsURLConnection? = null
        try {
            val sslSocketFactory = if (keyAlias != null && certificatePem != null) {
                val ks = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
                if (!ks.containsAlias(keyAlias)) return call.reject("La clé '$keyAlias' n'existe pas")
                val privateKey = ks.getKey(keyAlias, null) as PrivateKey

                val cert = CertificateFactory.getInstance("X.509")
                    .generateCertificate(ByteArrayInputStream(certificatePem.toByteArray(StandardCharsets.UTF_8))) as X509Certificate

                val sslContext = SSLContext.getInstance("TLS")
                sslContext.init(arrayOf(DeviceKeyManager(keyAlias, privateKey, arrayOf(cert))), null, null)
                sslContext.socketFactory
            } else null

            connection = (url.openConnection() as HttpsURLConnection).apply {
                if (sslSocketFactory != null) this.sslSocketFactory = sslSocketFactory
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                for (key in headersObj.keys()) {
                    val value = headersObj.optString(key, null)
                    if (value != null) setRequestProperty(key, value)
                }
            }

            OutputStreamWriter(connection.outputStream, StandardCharsets.UTF_8).use { it.write(body) }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: ""

            call.resolve(JSObject().put("status", status).put("body", text))
        } catch (e: Exception) {
            call.reject("Requête MEV-WEB impossible: ${e.message}", e)
        } finally {
            connection?.disconnect()
        }
    }
}
