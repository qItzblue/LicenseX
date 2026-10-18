package com.example.myplugin;

import java.util.Optional;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.java.JavaPlugin;

import dev.licensex.client.LicenseClient;
import com.example.myplugin.remote.RemoteFeature;

/**
 * Thin-client plugin template.
 *
 *  - The license is verified with your LicenseX server on startup (integrated client; no wrapper needed).
 *  - A "local" command runs in the jar (strippable - keep only cheap/cosmetic things here).
 *  - A "remote" command's code is loaded from your server at runtime and is NOT in the jar. Strip the license and
 *    it simply cannot run. Put the features people PAY for behind this path.
 *
 * Build:  ./build.sh         (builds the plugin jar AND compiles the server-side classes into ./server-out)
 * Then upload the plugin jar to LicenseX as a product, and copy ./server-out/*.class into your server's remote
 * class store (server/prototype/remote/ in LicenseX).
 */
public final class MyPlugin extends JavaPlugin {
    private static final String BBB_LICENSE = "%%__BBB_LICENSE__%%";
    private LicenseClient client;
    private String key;
    private volatile boolean licensed;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        Optional<LicenseClient.Embedded> emb = LicenseClient.embedded();
        String url = emb.map(LicenseClient.Embedded::url).filter(s -> s != null && !s.isBlank())
                .orElse(getConfig().getString("licensex-url", "https://licenses.example.com"));
        client = new LicenseClient(url, getDataFolder().toPath());
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            try {
                Optional<String> k = client.storedKey();
                if (k.isEmpty() && emb.isPresent()) k = client.useKey(emb.get().key());
                if (k.isEmpty() && BBB_LICENSE.startsWith("LX-")) k = client.useKey(BBB_LICENSE);
                if (k.isEmpty()) k = Optional.ofNullable(getConfig().getString("license-key")).filter(s -> !s.isBlank());
                if (k.isEmpty()) { getLogger().severe("[License] No license found."); return; }
                key = k.get();
            } catch (Exception e) { getLogger().severe("[License] Could not reach the server: " + e.getMessage()); return; }
            LicenseClient.Result r = client.validate(key, Bukkit.getServer().getName(), Bukkit.getPort(), getDescription().getVersion());
            if (!r.ok() && !r.network()) { getLogger().severe("[License] " + r.message()); return; }
            licensed = true;
            getLogger().info("[License] Verified. Plugin ready.");
        });
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!licensed) { sender.sendMessage("Not licensed / still starting."); return true; }
        switch (command.getName().toLowerCase()) {
            case "mylocal" -> {               // cheap, local, strippable: fine for cosmetic things
                sender.sendMessage("This is a local command (runs from the jar).");
                return true;
            }
            case "myfeature" -> {             // the paid feature: its code lives on your server
                final String who = sender.getName(), arg = args.length > 0 ? args[0] : "";
                Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
                    String out;
                    byte[] code = client.remoteClass(key, "ServerFeature");
                    if (code == null) out = "This feature is unavailable (no valid license).";
                    else try {
                        Class<?> c = new Loader(getClass().getClassLoader()).define("com.example.myplugin.remote.ServerFeature", code);
                        out = ((RemoteFeature) c.getDeclaredConstructor().newInstance()).run(who, arg);
                    } catch (Throwable t) { out = "Could not load the feature."; }
                    final String msg = out;
                    Bukkit.getScheduler().runTask(this, () -> sender.sendMessage(msg));
                });
                return true;
            }
            default -> { return false; }
        }
    }

    /** Loads a class from bytes fetched at runtime, with the plugin classloader as parent so RemoteFeature resolves. */
    static final class Loader extends ClassLoader {
        Loader(ClassLoader parent) { super(parent); }
        Class<?> define(String name, byte[] b) { return defineClass(name, b, 0, b.length); }
    }
}
