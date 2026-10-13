package dev.licensex.wrap;

import org.bukkit.plugin.java.JavaPlugin;

/** Periodic license check (runs off the main thread). */
final class Beat implements Runnable {
    private final JavaPlugin plugin;

    Beat(JavaPlugin plugin) { this.plugin = plugin; }

    @Override
    public void run() { Gate.beat(plugin); }
}
