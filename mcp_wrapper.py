import os
import subprocess
import sys

# Start with FULL env (important on Windows)
env = os.environ.copy()

# Remove router vars that crash pydantic in the MCP server
for k in [
    "LM_BASE_URL",
    "ROUTER_MODEL",
    "SHINE_MODEL",
    "PORT",
    "MCP_JSON_PATH",
    "MCP_SERVER_NAME",
    "SHINE_PROMPT_PATH",
]:
    env.pop(k, None)

# Provide token for MCP -> LM Studio auth
# (MCP server will read LM_API_TOKEN per LM Studio docs error message)
env["LM_API_TOKEN"] = env.get("LMSTUDIO_API_KEY", "")
print("[mcp_wrapper] LMSTUDIO_API_KEY present:", bool(env.get("LMSTUDIO_API_KEY")))
print("[mcp_wrapper] LM_API_TOKEN length:", len(env.get("LM_API_TOKEN") or ""))
sys.stdout.flush()

py = r"C:\Users\Lana\AppData\Local\Programs\Python\Python311\python.exe"
server = r"E:\memory\persistent-ai-memory\ai_memory_mcp_server.py"

# DEBUG: write env proof to a file (no token printed)
debug_path = r"E:\Shine Voice\router_api\mcp_env_debug.txt"
with open(debug_path, "w", encoding="utf-8") as f:
    f.write(f"LMSTUDIO_API_KEY present: {bool(env.get('LMSTUDIO_API_KEY'))}\n")
    f.write(f"LM_API_TOKEN present: {bool(env.get('LM_API_TOKEN'))}\n")
    f.write(f"LM_API_TOKEN length: {len(env.get('LM_API_TOKEN') or '')}\n")
    
sys.exit(subprocess.call([py, server], env=env, cwd=r"E:\memory\persistent-ai-memory"))