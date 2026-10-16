package net.xdevstudios.xhello;

import java.util.Optional;
import java.util.concurrent.ThreadLocalRandom;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

import dev.licensex.client.LicenseClient;

/**
 * XHello: a tiny prototype plugin from XdevStudios, with the LicenseX client built in (integrated, not wrapped).
 * The commands only start working once the license has been confirmed; a denied license disables the plugin.
 */
public final class XHello extends JavaPlugin {
    private static final String TAG = ChatColor.RED + "[XHello] " + ChatColor.RESET;
    // BuiltByBit overwrites this literal with the buyer's key at download time (External license key placeholder).
    private static final String BBB_LICENSE = "%%__BBB_LICENSE__%%";
    private static final long OFFLINE_GRACE_MILLIS = 72L * 3600_000L;

    private LicenseClient client;
    private String key;
    private boolean ready;
    private long lastGoodMillis = System.currentTimeMillis();
    private BukkitTask heartbeat;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        Optional<LicenseClient.Embedded> embedded = LicenseClient.embedded();
        String url = embedded.map(LicenseClient.Embedded::url).filter(s -> s != null && !s.isBlank())
                .orElse(getConfig().getString("licensex-url", "https://licenses.example.com"));
        client = new LicenseClient(url, getDataFolder().toPath());
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> startup(embedded));
    }

    private void startup(Optional<LicenseClient.Embedded> embedded) {
        try {
            Optional<String> k = client.storedKey();
            if (k.isEmpty() && embedded.isPresent()) k = client.useKey(embedded.get().key());
            if (k.isEmpty() && BBB_LICENSE.startsWith("LX-")) k = client.useKey(BBB_LICENSE);
            if (k.isEmpty()) k = Optional.ofNullable(getConfig().getString("license-key")).filter(s -> !s.isBlank());
            if (k.isEmpty()) { fail("No license found. Set license-key in config.yml."); return; }
            key = k.get();
        } catch (Exception e) { fail("Could not reach the license server: " + e.getMessage()); return; }

        LicenseClient.Result r = check();
        if (r.denied()) { fail(r.message()); return; }
        if (r.network()) {
            if (!client.verifiedWithin(OFFLINE_GRACE_MILLIS)) { fail("Could not reach the license server: " + r.message()); return; }
            getLogger().warning("[LicenseX] License server unreachable; continuing on the last successful check.");
        } else {
            client.markVerified();
            getLogger().info("[LicenseX] License " + key + " verified. Check or manage it at " + client.portalUrl(key));
        }
        Bukkit.getScheduler().runTask(this, () -> {
            ready = true;
            getLogger().info("XHello is ready. Try /xhello, /xflip, /xroll and /xtime.");
        });
        long ticks = r.heartbeatMinutes() * 60L * 20L;
        heartbeat = Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::beat, ticks, ticks);
    }

    private LicenseClient.Result check() {
        return client.validate(key, Bukkit.getServer().getName() + " " + Bukkit.getMotd(), Bukkit.getPort(), getDescription().getVersion());
    }

    private void beat() {
        LicenseClient.Result r = check();
        if (r.ok()) { lastGoodMillis = System.currentTimeMillis(); client.markVerified(); return; }
        if (r.network()) {
            if (System.currentTimeMillis() - lastGoodMillis > OFFLINE_GRACE_MILLIS) fail("License server unreachable for too long.");
            return;
        }
        fail(r.message());
    }

    private void fail(String why) {
        getLogger().severe("[LicenseX] License check failed: " + why);
        Bukkit.getScheduler().runTask(this, () -> Bukkit.getPluginManager().disablePlugin(this));
    }

    @Override
    public void onDisable() { if (heartbeat != null) heartbeat.cancel(); }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!ready) { sender.sendMessage(TAG + ChatColor.GRAY + "Still starting up, try again in a moment."); return true; }
        switch (command.getName().toLowerCase()) {
            case "xhello" -> {
                if (args.length == 0) { sender.sendMessage(TAG + "Hello, " + sender.getName() + "!"); return true; }
                Player target = Bukkit.getPlayerExact(args[0]);
                if (target == null) { sender.sendMessage(TAG + ChatColor.GRAY + args[0] + " is not online."); return true; }
                target.sendMessage(TAG + sender.getName() + " says hello!");
                sender.sendMessage(TAG + "You said hello to " + target.getName() + ".");
                return true;
            }
            case "xflip" -> {
                sender.sendMessage(TAG + "The coin landed on " + ChatColor.GOLD + (ThreadLocalRandom.current().nextBoolean() ? "heads" : "tails") + ChatColor.RESET + ".");
                return true;
            }
            case "xroll" -> {
                int sides = 6;
                if (args.length > 0) {
                    try { sides = Integer.parseInt(args[0]); } catch (NumberFormatException e) { sides = 0; }
                    if (sides < 2 || sides > 1000) { sender.sendMessage(TAG + ChatColor.GRAY + "Pick a number of sides between 2 and 1000."); return true; }
                }
                int roll = ThreadLocalRandom.current().nextInt(1, sides + 1);
                sender.sendMessage(TAG + "You rolled " + ChatColor.GOLD + roll + ChatColor.RESET + " (d" + sides + ").");
                return true;
            }
            case "xtime" -> {
                if (!(sender instanceof Player p)) { sender.sendMessage(TAG + "Only players have a world."); return true; }
                long t = (p.getWorld().getTime() + 6000) % 24000;
                sender.sendMessage(TAG + "It is " + ChatColor.GOLD + String.format("%02d:%02d", t / 1000, t % 1000 * 60 / 1000) + ChatColor.RESET + " in " + p.getWorld().getName() + ".");
                return true;
            }
            default -> { return false; }
        }
    }
}
