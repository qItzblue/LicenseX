package dev.licensex.wrap;

import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;

/** Disables the plugin on the main thread after a failed check. */
final class Disable implements Runnable {
    private final JavaPlugin plugin;

    Disable(JavaPlugin plugin) { this.plugin = plugin; }

    @Override
    public void run() { Bukkit.getPluginManager().disablePlugin(plugin); }
}
