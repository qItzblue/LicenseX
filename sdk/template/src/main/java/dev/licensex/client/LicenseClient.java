package dev.licensex.client;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Minimal LicenseX client. No Bukkit and no JSON library, so it can be dropped into any plugin
 * (or tested standalone). All methods block; call them off the main thread.
 */
public final class LicenseClient {

    public record Result(boolean ok, String code, String message, int heartbeatMinutes, boolean network) {
        /** The server answered and said no (as opposed to being unreachable). */
        public boolean denied() { return !ok && !network; }
    }

    private final String baseUrl;
    private final Path dataDir;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();

    public LicenseClient(String baseUrl, Path dataDir) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.dataDir = dataDir;
    }

    /** The license details LicenseX stamps into the jar at download time (resource /licensex.json). */
    public record Embedded(String url, String key, String product, String pub) {}

    /**
     * Reads /licensex.json from the jar, written by LicenseX when the buyer downloaded this exact copy.
     * When present, the plugin is licensed out of the box with no config and no separate network call.
     */
    public static Optional<Embedded> embedded() {
        try (InputStream in = LicenseClient.class.getResourceAsStream("/licensex.json")) {
            if (in == null) return Optional.empty();
            String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            String key = field(json, "key");
            return key.isEmpty() ? Optional.empty() : Optional.of(new Embedded(field(json, "url"), key, field(json, "product"), field(json, "pub")));
        } catch (IOException e) { return Optional.empty(); }
    }

    /** Persist a key supplied out of band (stamped into the jar) so it becomes this install's permanent license. */
    public Optional<String> useKey(String key) throws IOException {
        if (key == null || key.isBlank()) return Optional.empty();
        Files.createDirectories(dataDir);
        Files.writeString(dataDir.resolve("license.key"), key.trim());
        return Optional.of(key.trim());
    }

    /** The stored license, if this install already has one. */
    public Optional<String> storedKey() {
        try {
            Path f = dataDir.resolve("license.key");
            return Files.exists(f) ? Optional.of(Files.readString(f).trim()).filter(s -> !s.isEmpty()) : Optional.empty();
        } catch (IOException e) { return Optional.empty(); }
    }

    /** Remember that the server confirmed this license just now (lets a restart ride out a short outage). */
    public void markVerified() {
        try { Files.createDirectories(dataDir); Files.writeString(dataDir.resolve(".last-ok"), Long.toString(System.currentTimeMillis())); }
        catch (IOException ignored) {}
    }

    /** True if the server confirmed this license within the last {@code graceMillis}. */
    public boolean verifiedWithin(long graceMillis) {
        try {
            Path f = dataDir.resolve(".last-ok");
            return Files.exists(f) && System.currentTimeMillis() - Long.parseLong(Files.readString(f).trim()) < graceMillis;
        } catch (IOException | RuntimeException e) { return false; }
    }

    /** Link to this license's own page on the LicenseX website. */
    public String portalUrl(String key) { return baseUrl + "/?key=" + key; }

    /** Register this server with the license, or heartbeat if already registered. */
    public Result validate(String key, String serverName, int port, String version) {
        try {
            Resp r = post("/api/v1/validate", "{\"key\":" + q(key) + ",\"instanceId\":" + q(instanceId()) + ",\"name\":" + q(serverName)
                    + ",\"port\":" + port + ",\"version\":" + q(version) + "}");
            boolean ok = r.body.matches("(?s).*\"ok\"\\s*:\\s*true.*");
            String code = field(r.body, "code");
            if ("SERVER_REMOVED".equals(code)) deleteInstanceId(); // next start registers as a fresh server
            String hb = field(r.body, "heartbeat_minutes");
            int minutes = hb.isEmpty() ? 1 : Math.max(1, Integer.parseInt(hb));
            return new Result(ok, code, field(r.body, "message"), minutes, false);
        } catch (IOException | RuntimeException e) {
            return new Result(false, "NETWORK", e.getMessage(), 1, true);
        }
    }

    /** Result of a server-computed feature: ok plus the server's text (empty when the server declined or was unreachable). */
    public record Feature(boolean ok, String text) {}

    /**
     * Asks the server to compute a feature. The plugin has NO local version of this, so if the license is invalid, or
     * the call is stripped out, there is simply no result to show. This is the part a "disable the guards" crack
     * cannot recreate, because it was never in the jar.
     */
    public Feature feature(String key, String name, String params) {
        String pub = embedded().map(Embedded::pub).orElse("");
        if (pub.isEmpty()) return new Feature(false, "");   // no public key to verify with: fail closed
        try {
            byte[] nb = new byte[18]; new SecureRandom().nextBytes(nb);
            String nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nb);
            Resp r = post("/api/v1/feature", "{\"key\":" + q(key) + ",\"instanceId\":" + q(instanceId())
                    + ",\"feature\":" + q(name) + ",\"params\":" + q(params == null ? "" : params) + ",\"nonce\":" + q(nonce) + "}");
            String data = field(r.body, "data"), sig = field(r.body, "sig");
            if (data.isEmpty() || sig.isEmpty() || !verify(pub, data, sig)) return new Feature(false, "");
            String[] parts = data.split("\\|", 3);          // nonce | unix-seconds | text
            if (parts.length != 3 || !parts[0].equals(nonce)) return new Feature(false, "");   // replay / wrong nonce
            long ts = Long.parseLong(parts[1]);
            if (Math.abs(System.currentTimeMillis() / 1000 - ts) > 60) return new Feature(false, "");   // stale
            return new Feature(true, parts[2]);
        } catch (Exception e) {
            return new Feature(false, "");
        }
    }

    /**
     * Fetches a feature's compiled class bytes from the server (signed, nonce-bound). The implementation is not in the
     * jar, so without a valid license there is nothing to load. Returns the verified bytes, or null.
     */
    public byte[] remoteClass(String key, String name) {
        String pub = embedded().map(Embedded::pub).orElse("");
        if (pub.isEmpty()) return null;
        try {
            byte[] nb = new byte[18]; new SecureRandom().nextBytes(nb);
            String nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nb);
            Resp r = post("/api/v1/class", "{\"key\":" + q(key) + ",\"instanceId\":" + q(instanceId())
                    + ",\"name\":" + q(name) + ",\"nonce\":" + q(nonce) + "}");
            String data = field(r.body, "data"), sig = field(r.body, "sig");
            if (data.isEmpty() || sig.isEmpty() || !verify(pub, data, sig)) return null;
            String[] parts = data.split("\\|", 3);          // nonce | unix-seconds | base64(classbytes)
            if (parts.length != 3 || !parts[0].equals(nonce)) return null;
            if (Math.abs(System.currentTimeMillis() / 1000 - Long.parseLong(parts[1])) > 60) return null;
            return Base64.getDecoder().decode(parts[2]);
        } catch (Exception e) { return null; }
    }

    /** Verifies an Ed25519 signature of `data` against the embedded public key. A fake server cannot forge this. */
    private static boolean verify(String pubB64, String data, String sigB64) {
        try {
            PublicKey pk = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(pubB64)));
            Signature s = Signature.getInstance("Ed25519");
            s.initVerify(pk);
            s.update(data.getBytes(StandardCharsets.UTF_8));
            return s.verify(Base64.getDecoder().decode(sigB64));
        } catch (Exception e) {
            return false;
        }
    }

    // --- internals ---------------------------------------------------------------
    private record Resp(int status, String body) {}

    private Resp post(String path, String json) throws IOException {
        try {
            HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create(baseUrl + path)).timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(json)).build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            return new Resp(r.statusCode(), r.body());
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException(e); }
    }

    /** Random id persisted on disk: identifies this server instance across restarts and IP changes. */
    private String instanceId() throws IOException {
        Path f = dataDir.resolve(".instance-id");
        if (Files.exists(f)) return Files.readString(f).trim();
        Files.createDirectories(dataDir);
        String id = UUID.randomUUID().toString();
        Files.writeString(f, id);
        return id;
    }
    private void deleteInstanceId() { try { Files.deleteIfExists(dataDir.resolve(".instance-id")); } catch (IOException ignored) {} }

    private static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|(-?\\d+))").matcher(json);
        return m.find() ? (m.group(1) != null ? m.group(1).replace("\\\"", "\"").replace("\\\\", "\\") : m.group(2)) : "";
    }

    private static String q(String s) {
        if (s == null) s = "";
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                default -> { if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c); }
            }
        }
        return b.append('"').toString();
    }
}
