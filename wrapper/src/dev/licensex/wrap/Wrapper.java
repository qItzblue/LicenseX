package dev.licensex.wrap;

/**
 * Becomes the plugin's main class (plugin.yml "main" is rewritten to point here). Extends the original main class
 * (see Stub), so the original plugin runs unchanged, but only after the license has been verified.
 */
public final class Wrapper extends Stub {
    private boolean started;

    @Override
    public void onEnable() {
        if (!Gate.verify(this)) {
            org.bukkit.Bukkit.getPluginManager().disablePlugin(this);
            return;
        }
        started = true;
        super.onEnable();
        Gate.startHeartbeat(this);
    }

    @Override
    public void onDisable() {
        Gate.stop();
        if (started) {
            started = false;
            super.onDisable();
        }
    }
}
