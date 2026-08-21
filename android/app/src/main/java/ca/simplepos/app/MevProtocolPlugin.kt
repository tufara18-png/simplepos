package ca.simplepos.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Sends the MEV-WEB request itself, from the device, instead of through a Supabase Edge
 * Function relay. Confirmed live (2026-08-21) that Deno's fetch() drops the IDVERSI header en
 * route to Revenu Québec's DEV "enrolement" endpoint for reasons still unexplained, while the
 * exact same headers sent via curl or Node's https module arrive intact -- so the request goes
 * out through Android's own network stack (HttpURLConnection), a different, unrelated HTTP
 * client, rather than trying to work around a bug in a runtime this app does not otherwise use.
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
    }

    @PluginMethod
    fun sendRequest(call: PluginCall) {
        val urlString = call.getString("url") ?: return call.reject("url requis")
        val body = call.getString("body") ?: return call.reject("body requis")
        val headersObj = call.getObject("headers") ?: JSObject()

        val url = try { URL(urlString) } catch (e: Exception) { return call.reject("URL invalide: ${e.message}") }
        if (url.protocol != "https") return call.reject("HTTPS requis")
        if (!url.host.endsWith(ALLOWED_HOST_SUFFIX) && url.host != "rq-fo.ca") {
            return call.reject("Domaine non autorisé: ${url.host}")
        }

        var connection: HttpURLConnection? = null
        try {
            connection = (url.openConnection() as HttpURLConnection).apply {
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
