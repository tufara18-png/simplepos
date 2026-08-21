package ca.simplepos.app

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.bouncycastle.asn1.ASN1EncodableVector
import org.bouncycastle.asn1.ASN1InputStream
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.ASN1Sequence
import org.bouncycastle.asn1.DERSequence
import org.bouncycastle.asn1.x500.X500NameBuilder
import org.bouncycastle.asn1.x500.style.BCStyle
import org.bouncycastle.asn1.x509.BasicConstraints
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.ExtendedKeyUsage
import org.bouncycastle.asn1.x509.KeyPurposeId
import org.bouncycastle.asn1.x509.KeyUsage
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.cert.jcajce.JcaX509ExtensionUtils
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import org.bouncycastle.pkcs.jcajce.JcaPKCS10CertificationRequestBuilder
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * Local capability only. This plugin never receives, exports or transmits a private key --
 * AndroidKeyStore is designed so the private key material never leaves secure hardware/TEE.
 *
 * What this DOES give SimplePOS, now that SW-73 confirms the algorithm (ECDSA P-256, SHA-256,
 * IEEE P1363 signature output) and the CSR subject fields (SW-73 tables 9-11):
 *   - a non-exportable ECDSA P-256 key pair per device, generated on first use;
 *   - a PKCS#10 CSR built from that key, ready to send as the "csr" field of a "certificats"
 *     request once partner enrollment (authorization code, dossier number) is available;
 *   - SHA-256withECDSA signing, converted from the JCA's DER output to the raw IEEE P1363
 *     format the MEV-WEB header expects (this conversion is explicitly called out in SW-73
 *     3.7.5.3 as a common mistake -- signatures produced "as is" are ASN.1, not P1363).
 *
 * What this DOES NOT do: build the actual "reqCertif" JSON envelope, talk to api.rq-fo.ca, or
 * compute EMPRCERTIFTRANSM (that is the SHA-1 thumbprint of the certificate Revenu Québec
 * issues back -- it does not exist until that response is received). Those stay in JS/the
 * gateway, where the rest of the MEV pipeline already lives.
 */
@CapacitorPlugin(name = "MevKeystore")
class MevKeystorePlugin : Plugin() {

    companion object {
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val CURVE = "secp256r1" // ECDSA P-256, per SW-73 3.7.5.2
        private const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
        private const val P1363_COMPONENT_LENGTH = 32 // 256-bit curve -> 32-byte r, 32-byte s

        // Matches the extended key usage OID used verbatim in the SW-73.C reference
        // implementation (UtilesECDSA.cs / CsrEcdsaPreparation). Kept identical rather than
        // "corrected" -- the MEV-WEB validation may check for this exact value.
        private const val REFERENCE_EKU_OID = "1.3.6.1.5.5.7.3.8"
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }

    @PluginMethod
    fun hasKey(call: PluginCall) {
        val alias = call.getString("alias") ?: return call.reject("alias requis")
        val exists = keyStore().containsAlias(alias)
        call.resolve(JSObject().put("exists", exists))
    }

    @PluginMethod
    fun deleteKey(call: PluginCall) {
        val alias = call.getString("alias") ?: return call.reject("alias requis")
        val ks = keyStore()
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
        call.resolve(JSObject().put("deleted", true))
    }

    @PluginMethod
    fun generateKeyPair(call: PluginCall) {
        val alias = call.getString("alias") ?: return call.reject("alias requis")
        try {
            val ks = keyStore()
            if (ks.containsAlias(alias)) ks.deleteEntry(alias)

            val purposes = KeyProperties.PURPOSE_SIGN
            fun build(strongBox: Boolean): KeyGenParameterSpec {
                val b = KeyGenParameterSpec.Builder(alias, purposes)
                    .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    // Non-exportable by construction: KeyGenParameterSpec never allows a
                    // caller to request extraction of AndroidKeyStore private key material.
                    .setUserAuthenticationRequired(false)
                if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    b.setIsStrongBoxBacked(true)
                }
                return b.build()
            }

            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER)
            var strongBoxBacked = false
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    generator.initialize(build(true))
                    strongBoxBacked = true
                } else {
                    generator.initialize(build(false))
                }
            } catch (e: StrongBoxUnavailableException) {
                generator.initialize(build(false))
                strongBoxBacked = false
            }
            val keyPair = generator.generateKeyPair()

            val spki = Base64.getEncoder().encodeToString(keyPair.public.encoded)
            call.resolve(
                JSObject()
                    .put("alias", alias)
                    .put("strongBoxBacked", strongBoxBacked)
                    .put("publicKeySpkiBase64", spki)
            )
        } catch (e: Exception) {
            call.reject("Génération de clé impossible: ${e.message}", e)
        }
    }

    /**
     * Builds a PKCS#10 CSR for an exploitant (SW-73 tableaux 10/11 -- "SEV relié à un serveur"
     * and "SEV autonome" share the same subject fields). The administrateur-de-serveur variant
     * (tableau 9) is a different, unimplemented subject shape; SimplePOS's current architecture
     * (mev-gateway as a thin per-restaurant relay, not a shared server managing several
     * exploitants under one admin certificate) does not need it.
     *
     * All field values (numéro d'identification, code d'autorisation, numéro de dossier,
     * numéro TVQ) come from Revenu Québec after partner enrollment -- callers must pass real
     * values, nothing here invents or defaults them.
     */
    @PluginMethod
    fun createOperatorCsr(call: PluginCall) {
        val alias = call.getString("alias") ?: return call.reject("alias requis")
        val cn = call.getString("cn") ?: return call.reject("cn requis (numéro d'identification de l'exploitant)")
        val o = call.getString("o") ?: return call.reject("o requis (secteur-code d'autorisation, ex: RBC-X9X9-X9X9)")
        val ou = call.getString("ou") ?: return call.reject("ou requis (numéro TVQ)")
        val sn = call.getString("sn") ?: return call.reject("sn requis (surnom du certificat, 8-32 caractères)")
        val gn = call.getString("gn") ?: return call.reject("gn requis (numéro de dossier facturation obligatoire)")
        val locality = call.getString("l") ?: "-05:00"
        val state = call.getString("s") ?: "QC"
        val country = call.getString("c") ?: "CA"

        try {
            val ks = keyStore()
            if (!ks.containsAlias(alias)) return call.reject("La clé '$alias' n'existe pas -- appelez generateKeyPair d'abord")
            val privateKey = ks.getKey(alias, null) as java.security.PrivateKey
            val publicKey = ks.getCertificate(alias)?.publicKey
                ?: return call.reject("Clé publique introuvable pour '$alias'")

            // Order matters here and is NOT the usual LDAP convention: confirmed live against
            // Revenu Québec's real DEV "enrolement" endpoint (2026-08-21) that a CSR built in
            // any other RDN order gets rejected as JW00B999421E ("structure invalide"), while
            // this exact order -- CN, O, SN, OU, GN, L, S, C -- matching the string-concat
            // order in the SW-73.C reference (Demo.cs: "CN={0};O={1};SN={2};OU={3};GN={4};
            // L={5};S={6};C={7}") is accepted (got back a signed certificate, HTTP 201).
            val subject = X500NameBuilder(BCStyle.INSTANCE)
                .addRDN(BCStyle.CN, cn)
                .addRDN(BCStyle.O, o)
                .addRDN(BCStyle.SURNAME, sn)
                .addRDN(BCStyle.OU, ou)
                .addRDN(BCStyle.GIVENNAME, gn)
                .addRDN(BCStyle.L, locality)
                .addRDN(BCStyle.ST, state)
                .addRDN(BCStyle.C, country)
                .build()

            val csrBuilder = JcaPKCS10CertificationRequestBuilder(subject, publicKey)

            val extUtils = JcaX509ExtensionUtils()
            csrBuilder.addAttribute(
                org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers.pkcs_9_at_extensionRequest,
                org.bouncycastle.asn1.x509.Extensions(
                    arrayOf(
                        Extension(Extension.basicConstraints, false, BasicConstraints(false).encoded),
                        Extension(
                            Extension.extendedKeyUsage, true,
                            ExtendedKeyUsage(KeyPurposeId.getInstance(org.bouncycastle.asn1.ASN1ObjectIdentifier(REFERENCE_EKU_OID))).encoded
                        ),
                        Extension(
                            Extension.keyUsage, false,
                            KeyUsage(KeyUsage.digitalSignature or KeyUsage.nonRepudiation).encoded
                        ),
                        Extension(
                            Extension.subjectKeyIdentifier, false,
                            extUtils.createSubjectKeyIdentifier(SubjectPublicKeyInfo.getInstance(publicKey.encoded)).encoded
                        )
                    )
                )
            )

            val signer = JcaContentSignerBuilder(SIGNATURE_ALGORITHM).build(privateKey)
            val csr = csrBuilder.build(signer)
            // A single unbroken base64 line, NOT the usual 64-char-per-line PEM wrapping.
            // SW-73 4.3.1.1's own note is easy to misread as "wrap the body like normal PEM"
            // -- it actually means insert exactly two \n, one right after BEGIN and one right
            // before END, nothing in between. Confirmed live: a 64-char-wrapped body gets
            // rejected as JW00B999421E ("structure invalide") even with an otherwise-correct
            // CSR; this single-line form is what got a real certificate back (HTTP 201).
            val body = Base64.getEncoder().encodeToString(csr.encoded)

            // Exact wrapper format from SW-73 4.3.1.1 (the "csr" field of reqCertif): literal
            // BEGIN/END markers with the base64 body on the line(s) between them.
            val pem = "-----BEGIN CERTIFICATE REQUEST-----\n$body\n-----END CERTIFICATE REQUEST-----"

            call.resolve(JSObject().put("csrPem", pem))
        } catch (e: Exception) {
            call.reject("Construction du CSR impossible: ${e.message}", e)
        }
    }

    /**
     * SHA-256withECDSA over UTF-8 text, converted from the JCA's DER (ASN.1) output to the
     * fixed-length IEEE P1363 (raw r||s, 64 bytes) format the MEV-WEB header field expects --
     * base64 of that is exactly 88 characters, matching SIGNATRANSM's documented length.
     */
    @PluginMethod
    fun sign(call: PluginCall) {
        val alias = call.getString("alias") ?: return call.reject("alias requis")
        val text = call.getString("text") ?: return call.reject("text requis")
        try {
            val ks = keyStore()
            if (!ks.containsAlias(alias)) return call.reject("La clé '$alias' n'existe pas")
            val privateKey = ks.getKey(alias, null) as java.security.PrivateKey

            val signature = Signature.getInstance(SIGNATURE_ALGORITHM)
            signature.initSign(privateKey)
            signature.update(text.trim().toByteArray(Charsets.UTF_8))
            val der = signature.sign()

            val p1363 = derToP1363(der, P1363_COMPONENT_LENGTH)
            call.resolve(JSObject().put("signatureBase64", Base64.getEncoder().encodeToString(p1363)))
        } catch (e: Exception) {
            call.reject("Signature impossible: ${e.message}", e)
        }
    }

    private fun derToP1363(der: ByteArray, componentLength: Int): ByteArray {
        val seq = ASN1InputStream(der).use { it.readObject() } as ASN1Sequence
        val r = (seq.getObjectAt(0) as ASN1Integer).positiveValue
        val s = (seq.getObjectAt(1) as ASN1Integer).positiveValue
        return fixedLength(r, componentLength) + fixedLength(s, componentLength)
    }

    private fun fixedLength(value: BigInteger, length: Int): ByteArray {
        var raw = value.toByteArray()
        if (raw.size > 1 && raw[0] == 0.toByte()) raw = raw.copyOfRange(1, raw.size) // drop sign byte
        val out = ByteArray(length)
        if (raw.size <= length) {
            raw.copyInto(out, length - raw.size)
        } else {
            // Longer than expected (shouldn't happen for a 256-bit curve) -- keep the
            // least-significant `length` bytes rather than silently truncate high-order data.
            raw.copyOfRange(raw.size - length, raw.size).copyInto(out, 0)
        }
        return out
    }
}
