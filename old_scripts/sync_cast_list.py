import os
from plexapi.server import PlexServer

# --- CONFIG ---
PLEX_URL = 'http://localhost:32400'
PLEX_TOKEN = os.getenv('PLEX_TOKEN')
LIBRARY_NAME = 'TV Shows'
SOURCE_SHOW = 'One Piece'  # The official show to copy FROM
TARGET_SHOW = 'One Pace'   # Your project to copy TO
CAST_LIMIT = 30

def migrate_cast():
    # ... (connection logic remains the same) ...

    # 2. Grab the top roles from the source
    print(f"-> Fetching top {CAST_LIMIT} roles from '{SOURCE_SHOW}'...")
    source_roles = source.roles[:CAST_LIMIT]

    # 3. Build the edit dictionary
    # We map them to actor[0].tag, actor[0].role, etc.
    edits = {}
    for i, role in enumerate(source_roles):
        edits[f'actor[{i}].tag'] = role.tag
        edits[f'actor[{i}].role'] = role.role

    # 4. Apply to target
    print(f"-> Writing cast to '{TARGET_SHOW}'...")
    try:
        target.edit(**edits)
        print(f"[SUCCESS] Injected {len(source_roles)} roles.")
    except Exception as e:
        print(f" [!] Failed to edit roles: {e}")

if __name__ == "__main__":
    migrate_cast()