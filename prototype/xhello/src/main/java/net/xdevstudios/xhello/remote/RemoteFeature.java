package net.xdevstudios.xhello.remote;

/**
 * A feature whose IMPLEMENTATION is not shipped in the plugin jar. Only this interface is in the jar; the class that
 * implements it is fetched from XdevStudios' server at runtime (license-gated, signed) and loaded into memory. A
 * cracked copy with the license stripped never receives the implementation, so the feature cannot run at all.
 */
public interface RemoteFeature {
    String run(String who);
}
