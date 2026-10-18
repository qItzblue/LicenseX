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
import net.xdevstudios.xhello.remote.RemoteFeature;

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
    private final Guard guard = new Guard();

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
        guard.arm(key);                                   // interlocking license state, woven from the confirmed key
        Bukkit.getScheduler().runTask(this, () -> {
            ready = true;
            getLogger().info("XHello is ready. Try /xhello, /xflip, /xroll and /xtime.");
        });
        long ticks = r.heartbeatMinutes() * 60L * 20L;
        heartbeat = Bukkit.getScheduler().runTaskTimerAsynchronously(this, () -> { beat(); guard.audit(this); }, ticks, ticks);
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

    /** Defines a class from bytes fetched at runtime, with the plugin's own classloader as parent so RemoteFeature resolves. */
    static final class RemoteLoader extends ClassLoader {
        RemoteLoader(ClassLoader parent) { super(parent); }
        Class<?> define(String name, byte[] b) { return defineClass(name, b, 0, b.length); }
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!ready) { sender.sendMessage(TAG + ChatColor.GRAY + "Still starting up, try again in a moment."); return true; }
        // Each command passes a DIFFERENT gate index, so they lean on different interlocking signals. A single patch
        // that satisfies one command will not satisfy the others, and a failed gate pulls the whole plugin down.
        switch (command.getName().toLowerCase()) {
            case "xhello" -> {
                if (!guard.gate(this, 0)) return true;
                if (args.length == 0) { sender.sendMessage(TAG + "Hello, " + sender.getName() + "!"); return true; }
                Player target = Bukkit.getPlayerExact(args[0]);
                if (target == null) { sender.sendMessage(TAG + ChatColor.GRAY + args[0] + " is not online."); return true; }
                target.sendMessage(TAG + sender.getName() + " says hello!");
                sender.sendMessage(TAG + "You said hello to " + target.getName() + ".");
                return true;
            }
            case "xflip" -> {
                if (!guard.gate(this, 1)) return true;
                sender.sendMessage(TAG + "The coin landed on " + ChatColor.GOLD + (ThreadLocalRandom.current().nextBoolean() ? "heads" : "tails") + ChatColor.RESET + ".");
                return true;
            }
            case "xroll" -> {
                if (!guard.gate(this, 2)) return true;
                // SERVER-COMPUTED: the roll's result and text come from XdevStudios' server. There is no local roll in
                // this jar, so a cracked copy (license stripped) has nothing to fall back on — the command just fails.
                final String params = args.length > 0 ? args[0] : "";
                Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
                    LicenseClient.Feature f = client.feature(key, "roll", params);
                    Bukkit.getScheduler().runTask(this, () -> {
                        if (f.ok() && !f.text().isEmpty()) sender.sendMessage(TAG + ChatColor.GOLD + f.text());
                        else sender.sendMessage(TAG + ChatColor.GRAY + "The dice are unavailable right now (the server did not answer).");
                    });
                });
                return true;
            }
            case "xtime" -> {
                if (!guard.gate(this, 3)) return true;
                if (!(sender instanceof Player p)) { sender.sendMessage(TAG + "Only players have a world."); return true; }
                long t = (p.getWorld().getTime() + 6000) % 24000;
                sender.sendMessage(TAG + "It is " + ChatColor.GOLD + String.format("%02d:%02d", t / 1000, t % 1000 * 60 / 1000) + ChatColor.RESET + " in " + p.getWorld().getName() + ".");
                return true;
            }
            case "xsecret" -> {
                if (!guard.gate(this, 4)) return true;
                // REMOTE CLASS LOADING: the code that produces this command's result is NOT in the jar. We fetch it
                // (signed) from the server, load it into memory, and run it. Strip the license and the class never
                // arrives, so there is nothing to run and nothing to crack.
                final String who = sender.getName();
                Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
                    String out;
                    byte[] code = client.remoteClass(key, "ServerGreeting");
                    if (code == null) out = ChatColor.GRAY + "This feature is unavailable (the server did not provide it).";
                    else try {
                        Class<?> c = new RemoteLoader(getClass().getClassLoader()).define("net.xdevstudios.xhello.remote.ServerGreeting", code);
                        RemoteFeature f = (RemoteFeature) c.getDeclaredConstructor().newInstance();
                        out = ChatColor.LIGHT_PURPLE + f.run(who);
                    } catch (Throwable t) { out = ChatColor.GRAY + "Could not load the feature."; }
                    final String msg = out;
                    Bukkit.getScheduler().runTask(this, () -> sender.sendMessage(TAG + msg));
                });
                return true;
            }
            default -> { return false; }
        }
    }
}
