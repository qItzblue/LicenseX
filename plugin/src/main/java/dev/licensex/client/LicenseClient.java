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

    /** The license details LicenseX stamps into the jar at download time (resource /licensex.json). */
    public record Embedded(String url, String key, String product) {}

    /**
     * Reads /licensex.json from the jar, written by LicenseX when the buyer downloaded this exact copy.
     * When present, the plugin is licensed out of the box with no config and no separate network call.
     */
    public static Optional<Embedded> embedded() {
        try (InputStream in = LicenseClient.class.getResourceAsStream("/licensex.json")) {
            if (in == null) return Optional.empty();
            String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            String key = field(json, "key");
            return key.isEmpty() ? Optional.empty() : Optional.of(new Embedded(field(json, "url"), key, field(json, "product")));
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
