package com.acme.hello;

import org.bukkit.plugin.java.JavaPlugin;

/** A plain plugin with no knowledge of LicenseX. Used to prove LicenseX can license arbitrary plugins. */
public class HelloPlugin extends JavaPlugin {
    @Override
    public void onLoad() {
        getLogger().info("HELLO_LOADED");
    }

    @Override
    public void onEnable() {
        saveDefaultConfig();
        getLogger().info("HELLO_ENABLED greeting=" + getConfig().getString("greeting", "none")
                + " same-instance=" + (JavaPlugin.getPlugin(HelloPlugin.class) == this));
        getServer().getScheduler().runTaskTimer(this, () -> getLogger().info("HELLO_TICK"), 20L, 20L);
    }

    @Override
    public void onDisable() {
        getLogger().info("HELLO_DISABLED");
    }
}
