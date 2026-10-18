package net.xdevstudios.xhello.remote;

// Compiled separately and served by LicenseX — this .class is NEVER inside the plugin jar.
public final class ServerGreeting implements RemoteFeature {
    public String run(String who) {
        long n = System.currentTimeMillis() / 1000L;
        return "Arcane blessing for " + who + " #" + Long.toString(n, 36)
                + " - this code was loaded from XdevStudios' server and was never in the jar.";
    }
}
