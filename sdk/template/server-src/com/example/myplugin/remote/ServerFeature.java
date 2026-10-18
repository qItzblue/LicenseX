package com.example.myplugin.remote;

// SERVER-ONLY. Compiled by build.sh and uploaded to your LicenseX server's remote class store. Never in the jar.
// Put the real, valuable logic of your feature here. A cracked copy (license stripped) never receives this class,
// so the feature simply cannot run and there is nothing local to crack.
public final class ServerFeature implements RemoteFeature {
    public String run(String who, String arg) {
        return "Hello " + who + " - this result was computed by code served from the server, not shipped in the jar.";
    }
}
