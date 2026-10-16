package net.xdevstudios.xhello;

import java.util.concurrent.ThreadLocalRandom;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

/** XHello: a tiny prototype plugin. Four small commands, nothing else. */
public class XHello extends JavaPlugin {
    private static final String TAG = ChatColor.RED + "[XHello] " + ChatColor.RESET;

    @Override
    public void onEnable() {
        getLogger().info("XHello is ready. Try /xhello, /xflip, /xroll and /xtime.");
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        switch (command.getName().toLowerCase()) {
            case "xhello" -> {
                if (args.length == 0) { sender.sendMessage(TAG + "Hello, " + sender.getName() + "!"); return true; }
                Player target = Bukkit.getPlayerExact(args[0]);
                if (target == null) { sender.sendMessage(TAG + ChatColor.GRAY + args[0] + " is not online."); return true; }
                target.sendMessage(TAG + sender.getName() + " says hello!");
                sender.sendMessage(TAG + "You said hello to " + target.getName() + ".");
                return true;
            }
            case "xflip" -> {
                sender.sendMessage(TAG + "The coin landed on " + ChatColor.GOLD + (ThreadLocalRandom.current().nextBoolean() ? "heads" : "tails") + ChatColor.RESET + ".");
                return true;
            }
            case "xroll" -> {
                int sides = 6;
                if (args.length > 0) {
                    try { sides = Integer.parseInt(args[0]); } catch (NumberFormatException e) { sides = 0; }
                    if (sides < 2 || sides > 1000) { sender.sendMessage(TAG + ChatColor.GRAY + "Pick a number of sides between 2 and 1000."); return true; }
                }
                int roll = ThreadLocalRandom.current().nextInt(1, sides + 1);
                sender.sendMessage(TAG + "You rolled " + ChatColor.GOLD + roll + ChatColor.RESET + " (d" + sides + ").");
                return true;
            }
            case "xtime" -> {
                if (!(sender instanceof Player p)) { sender.sendMessage(TAG + "Only players have a world."); return true; }
                long t = (p.getWorld().getTime() + 6000) % 24000;   // tick 0 is 06:00
                sender.sendMessage(TAG + "It is " + ChatColor.GOLD + String.format("%02d:%02d", t / 1000, t % 1000 * 60 / 1000) + ChatColor.RESET + " in " + p.getWorld().getName() + ".");
                return true;
            }
            default -> { return false; }
        }
    }
}
