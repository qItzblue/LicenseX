package dev.licensex.client;

import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

import java.util.Optional;

/** Example of wiring LicenseX into a plugin. Copy LicenseClient plus the lifecycle below into yours. */
public final class ExamplePlugin extends JavaPlugin {

    // BuiltByBit replaces these literals in the downloaded jar. Each download has a unique nonce.
    private static final String BBB_USER = "%%__USER__%%";
    private static final String BBB_NONCE = "%%__NONCE__%%";
    private static final String PRODUCT = "example-plugin";

    private LicenseClient client;
    private String key;
    private BukkitTask heartbeat;
    private long lastGoodMillis = System.currentTimeMillis();
    private static final long OFFLINE_GRACE_MILLIS = 72L * 3600_000L;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        client = new LicenseClient(getConfig().getString("licensex-url", "http://localhost:3000"), getDataFolder().toPath());
        // Everything network-related runs async; the plugin stays disabled-by-default until a license is confirmed.
        Bukkit.getScheduler().runTaskAsynchronously(this, this::startup);
    }

    private void startup() {
        try {
            Optional<String> k = client.storedKey();
            if (k.isEmpty() && !BBB_NONCE.startsWith("%%")) k = client.claim(BBB_NONCE, BBB_USER, PRODUCT); // issued once per download
            if (k.isEmpty()) k = Optional.ofNullable(getConfig().getString("license-key")).filter(s -> !s.isBlank());
            if (k.isEmpty()) { fail("No license found. Set license-key in config.yml."); return; }
            key = k.get();
        } catch (Exception e) { fail("Could not reach the license server: " + e.getMessage()); return; }

        LicenseClient.Result r = check();
        if (!r.ok()) { fail(r.message()); return; }
        getLogger().info("License " + key + " verified.");
        Bukkit.getScheduler().runTask(this, this::enableFeatures);
        long ticks = r.heartbeatMinutes() * 60L * 20L;
        heartbeat = Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::beat, ticks, ticks);
    }

    private LicenseClient.Result check() {
        return client.validate(key, Bukkit.getServer().getName() + " " + Bukkit.getMotd(), Bukkit.getPort(), getDescription().getVersion());
    }

    private void beat() {
        LicenseClient.Result r = check();
        if (r.ok()) { lastGoodMillis = System.currentTimeMillis(); return; }
        if (r.network()) { // tolerate outages, but not forever
            if (System.currentTimeMillis() - lastGoodMillis > OFFLINE_GRACE_MILLIS) fail("License server unreachable for too long.");
            return;
        }
        fail(r.message());
    }

    private void fail(String why) {
        getLogger().severe("License check failed: " + why);
        Bukkit.getScheduler().runTask(this, () -> Bukkit.getPluginManager().disablePlugin(this));
    }

    /** Register commands/listeners here, only after the license is confirmed. */
    private void enableFeatures() {
        getLogger().info("ExamplePlugin enabled.");
    }

    @Override
    public void onDisable() { if (heartbeat != null) heartbeat.cancel(); }
}
