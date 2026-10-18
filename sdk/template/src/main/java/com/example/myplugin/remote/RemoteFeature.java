package com.example.myplugin.remote;

/** A feature whose implementation is served from your server and is never in the jar. Only this interface ships. */
public interface RemoteFeature {
    String run(String who, String arg);
}
