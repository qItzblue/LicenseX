package dev.licensex.wrap;

import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * License check used by wrapped plugins. Java 8 compatible, no dependencies beyond the Bukkit API.
 * Reads /licensex.json (written into the jar by LicenseX) and talks to POST {url}/api/v1/validate.
 */
public final class Gate {
    /** For jars sold on BuiltByBit: BuiltByBit overwrites this text with the buyer's key at download time. */
    static final String BBB_LICENSE = "%%__BBB_LICENSE__%%";
    private static final long OFFLINE_GRACE_MS = 72L * 3600L * 1000L;
    private static final Charset UTF8 = Charset.forName("UTF-8");

    private static String key = "";
    private static String baseUrl = "";
    private static int heartbeatMinutes = 1;
    private static BukkitTask task;

    private Gate() { }

    /** Outcome of one check. */
    static final class Result {
        final boolean ok;
        final boolean network;
        final String message;
        Result(boolean ok, boolean network, String message) { this.ok = ok; this.network = network; this.message = message; }
    }

    /** Startup check. Blocks (a few seconds at most) so the plugin never starts unlicensed. */
    public static boolean verify(JavaPlugin plugin) {
        loadConfig(plugin);
        if (baseUrl.isEmpty()) {
            plugin.getLogger().severe("[LicenseX] This plugin was not prepared correctly (no license server address). Download it again.");
            return false;
        }
        if (!key.startsWith("LX-")) {
            plugin.getLogger().severe("[LicenseX] No license key is built into this copy of the plugin. Download it again from the store, or contact the seller.");
            return false;
        }
        Result r = check(plugin);
        if (r.ok) {
            touch(plugin);
            plugin.getLogger().info("[LicenseX] License " + key + " verified. Check or manage it at " + baseUrl + "/?key=" + key);
            return true;
        }
        if (r.network && withinGrace(plugin)) {
            plugin.getLogger().warning("[LicenseX] License server unreachable (" + r.message + "). Continuing on the last successful check.");
            return true;
        }
        plugin.getLogger().severe("[LicenseX] " + r.message);
        return false;
    }

    public static void startHeartbeat(JavaPlugin plugin) {
        long ticks = Math.max(1, heartbeatMinutes) * 60L * 20L;
        task = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, new Beat(plugin), ticks, ticks);
    }

    public static void stop() {
        if (task != null) {
            task.cancel();
            task = null;
        }
    }

    /** Periodic check; disables the plugin if the license is no longer valid. */
    static void beat(JavaPlugin plugin) {
        Result r = check(plugin);
        if (r.ok) {
            touch(plugin);
            return;
        }
        if (r.network && withinGrace(plugin)) return;
        plugin.getLogger().severe("[LicenseX] " + r.message + " Disabling the plugin.");
        Bukkit.getScheduler().runTask(plugin, new Disable(plugin));
    }

    // ---------------------------------------------------------------------------------------------

    private static void loadConfig(JavaPlugin plugin) {
        key = "";
        baseUrl = "";
        InputStream in = plugin.getResource("licensex.json");
        if (in == null) return;
        try {
            String json = new String(readAll(in), UTF8);
            baseUrl = field(json, "url").replaceAll("/+$", "");
            String embedded = field(json, "key");
            key = embedded.startsWith("LX-") ? embedded : (BBB_LICENSE.startsWith("LX-") ? BBB_LICENSE : embedded);
        } catch (IOException ignored) {
            // leave empty; verify() reports it
        }
    }

    private static Result check(JavaPlugin plugin) {
        HttpURLConnection c = null;
        try {
            String motd = Bukkit.getMotd();
            String body = "{\"key\":" + q(key) + ",\"instanceId\":" + q(instanceId(plugin)) + ",\"name\":" + q(motd == null || motd.isEmpty() ? plugin.getName() : motd)
                    + ",\"port\":" + Bukkit.getPort() + ",\"version\":" + q(plugin.getDescription().getVersion()) + "}";
            c = (HttpURLConnection) new URL(baseUrl + "/api/v1/validate").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("User-Agent", "LicenseX-Wrap/1");
            OutputStream out = c.getOutputStream();
            try { out.write(body.getBytes(UTF8)); } finally { out.close(); }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            String resp = in == null ? "" : new String(readAll(in), UTF8);
            if (status == 429 || status >= 500) return new Result(false, true, "HTTP " + status);
            if (status == 200 && Pattern.compile("\"ok\"\\s*:\\s*true").matcher(resp).find()) {
                String hb = field(resp, "heartbeat_minutes");
                if (!hb.isEmpty()) heartbeatMinutes = Integer.parseInt(hb);
                return new Result(true, false, "");
            }
            String msg = field(resp, "message");
            return new Result(false, false, msg.isEmpty() ? "License check failed (HTTP " + status + ")." : msg);
        } catch (IOException e) {
            return new Result(false, true, String.valueOf(e.getMessage()));
        } catch (RuntimeException e) {
            return new Result(false, true, String.valueOf(e));
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Random id stored in the plugin folder: identifies this server instance across restarts and IP changes. */
    private static synchronized String instanceId(JavaPlugin plugin) throws IOException {
        File dir = plugin.getDataFolder();
        File f = new File(dir, ".licensex-instance");
        if (f.exists()) {
            String s = new String(Files.readAllBytes(f.toPath()), UTF8).trim();
            if (!s.isEmpty()) return s;
        }
        dir.mkdirs();
        String id = UUID.randomUUID().toString();
        Files.write(f.toPath(), id.getBytes(UTF8));
        return id;
    }

    private static void touch(JavaPlugin plugin) {
        try {
            plugin.getDataFolder().mkdirs();
            Files.write(new File(plugin.getDataFolder(), ".licensex-ok").toPath(), String.valueOf(System.currentTimeMillis()).getBytes(UTF8));
        } catch (IOException ignored) {
            // grace period just won't apply
        }
    }

    private static boolean withinGrace(JavaPlugin plugin) {
        try {
            File f = new File(plugin.getDataFolder(), ".licensex-ok");
            if (!f.exists()) return false;
            long last = Long.parseLong(new String(Files.readAllBytes(f.toPath()), UTF8).trim());
            return System.currentTimeMillis() - last < OFFLINE_GRACE_MS;
        } catch (IOException e) {
            return false;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    private static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|(-?\\d+))").matcher(json);
        if (!m.find()) return "";
        return m.group(1) != null ? m.group(1).replace("\\\"", "\"").replace("\\\\", "\\") : m.group(2);
    }

    private static String q(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') b.append("\\\"");
            else if (c == '\\') b.append("\\\\");
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }
}
