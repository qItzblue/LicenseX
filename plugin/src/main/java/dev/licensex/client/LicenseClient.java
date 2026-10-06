package dev.licensex.client;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
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

    /** The stored license, if this install already has one. */
    public Optional<String> storedKey() {
        try {
            Path f = dataDir.resolve("license.key");
            return Files.exists(f) ? Optional.of(Files.readString(f).trim()).filter(s -> !s.isEmpty()) : Optional.empty();
        } catch (IOException e) { return Optional.empty(); }
    }

    /**
     * Gets this install's license. The nonce is unique per download (BuiltByBit: %%__NONCE__%%), so each
     * download gets a new license even from the same IP/device, while repeated calls with the same nonce
     * return the same license. The result is persisted so the license never changes afterwards.
     */
    public Optional<String> claim(String nonce, String user, String product) throws IOException {
        String resp = post("/api/v1/claim", "{\"nonce\":" + q(nonce) + ",\"user\":" + q(user) + ",\"product\":" + q(product)
                + ",\"device\":" + q(deviceFingerprint()) + "}").body;
        Matcher m = Pattern.compile("\"key\"\\s*:\\s*\"(LX-[A-Z0-9-]+)\"").matcher(resp);
        if (!m.find()) return Optional.empty();
        Files.createDirectories(dataDir);
        Files.writeString(dataDir.resolve("license.key"), m.group(1));
        return Optional.of(m.group(1));
    }

    /** Register this server with the license, or heartbeat if already registered. */
    public Result validate(String key, String serverName, int port, String version) {
        try {
            Resp r = post("/api/v1/validate", "{\"key\":" + q(key) + ",\"instanceId\":" + q(instanceId()) + ",\"name\":" + q(serverName)
                    + ",\"port\":" + port + ",\"version\":" + q(version) + "}");
            boolean ok = r.body.matches("(?s).*\"ok\"\\s*:\\s*true.*");
            String code = field(r.body, "code");
            if ("SERVER_REMOVED".equals(code)) deleteInstanceId(); // next start registers as a fresh server
            String hb = field(r.body, "heartbeat_minutes");
            int minutes = hb.isEmpty() ? 15 : Math.max(1, Integer.parseInt(hb));
            return new Result(ok, code, field(r.body, "message"), minutes, false);
        } catch (IOException | RuntimeException e) {
            return new Result(false, "NETWORK", e.getMessage(), 15, true);
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

    private static String deviceFingerprint() {
        return System.getProperty("os.name") + "|" + System.getProperty("os.arch") + "|" + System.getProperty("user.name")
                + "|" + System.getenv().getOrDefault("HOSTNAME", System.getenv().getOrDefault("COMPUTERNAME", ""));
    }

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
