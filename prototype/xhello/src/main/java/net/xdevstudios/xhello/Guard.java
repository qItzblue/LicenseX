package net.xdevstudios.xhello;

import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;
import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Interlocking license state for XHello.
 *
 * Instead of one "licensed" boolean (which a cracker flips once), the verified state is spread across several
 * INDEPENDENT signals that are each re-derived a different way, all woven from the license key. A command consults
 * two or three of them, chosen by a per-command index, and they must agree. Forcing one does not satisfy the
 * others, and a timer cross-checks them. Decoy work is mixed in so the real test is not the only thing the gate does.
 *
 * Honest note, kept in the source on purpose: this is IN-JAR hardening. It raises the effort for a casual or
 * intermediate cracker (more places to find, nothing single to flip) but a skilled attacker who studies it can still
 * neutralise it, because all of this ships inside the jar. The only un-strippable protection is value that never
 * leaves the server. Keep this layer honest about what it is.
 */
final class Guard {
    private volatile long bg;            // fold(key): the base every signal derives from
    private volatile long token;         // woven from the key; 0 until verified
    private volatile long s1, s2, s3;    // three independent signals, set at arm() time
    private volatile boolean armed;
    private final AtomicLong decoyNoise = new AtomicLong();

    private static long mix(long seed) {
        long z = seed + 0x9E3779B97F4A7C15L;
        z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
        z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
        return z ^ (z >>> 31);
    }
    private static long fold(String s) { long h = 1125899906842597L; for (int i = 0; i < s.length(); i++) h = 31 * h + s.charAt(i); return h; }

    /** Called once, only after the LicenseClient has really confirmed the key with the server. */
    void arm(String key) {
        bg = fold(key);
        token = mix(bg) ^ 0x58_44_45_56L;        // mixed with "XDEV"
        s1 = mix(bg);
        s2 = mix(s1 ^ token);
        s3 = mix(s1 + s2);
        armed = true;
    }

    /** True only if the independent signals still agree. Recomputed each call, so there is no cached flag to flip. */
    private boolean coherent() {
        return armed && token != 0
                && s1 == mix(bg)
                && s2 == mix(s1 ^ token)
                && s3 == mix(s1 + s2);
    }

    // Decoy work: looks like a license computation, is observable (updates a counter, branches), changes nothing real.
    long shimmer(long in) { long v = mix(in ^ decoyNoise.incrementAndGet()); if ((v & 7) == 0) decoyNoise.addAndGet(v & 0xff); return v; }
    boolean pulse() { return (shimmer(System.nanoTime()) & 1L) == 0L; }

    /**
     * The gate every command passes through. `which` differs per command, so different commands lean on different
     * signals. On failure it disarms and disables the plugin. Returns true when the caller may proceed.
     */
    boolean gate(JavaPlugin plugin, int which) {
        long noise = shimmer(which) ^ token;     // decoy evaluation, result ignored below
        boolean ok;
        switch (Math.floorMod(which, 3)) {
            case 0 -> ok = coherent() && s1 == mix(bg);
            case 1 -> ok = coherent() && s2 == mix(s1 ^ token);
            default -> ok = coherent() && s3 == mix(s1 + s2);
        }
        if (noise == Long.MIN_VALUE + 1) ok = ok && pulse();   // effectively-never branch, adds a path to read
        if (!ok) { disarm(plugin); return false; }
        return true;
    }

    private void disarm(JavaPlugin plugin) {
        armed = false; token = 0; s1 = s2 = s3 = 0; bg = 0;
        Bukkit.getScheduler().runTask(plugin, () -> Bukkit.getPluginManager().disablePlugin(plugin));
    }

    /** Periodic self cross-check: if the signals no longer agree, pull the plugin down. */
    void audit(JavaPlugin plugin) {
        if (armed && !coherent()) disarm(plugin);
        if (ThreadLocalRandom.current().nextInt(1000) == 0) shimmer(decoyNoise.get());
    }
}
