import requests
import os
from plexapi.server import PlexServer

# --- CONFIG ---
PLEX_URL = 'http://localhost:32400'
PLEX_TOKEN = os.getenv('PLEX_TOKEN')
SHOW_NAME = 'One Pace'
LIBRARY_NAME = 'TV Shows'
SOURCE_URL = "https://raw.githubusercontent.com/ladyisatis/one-pace-metadata/refs/heads/v2/data.json"

def create_episode_id_string(season, episode):
    return f"s{int(season):02d}e{int(episode):02d}"

def sync_one_pace():
    print("* Starting... *")
    season_lookup = {}
    episode_lookup = {}

    print(f"-> Fetching {SOURCE_URL}")
    response = requests.get(SOURCE_URL)
    data = response.json()
    print("-> Fetched Complete")

    # Build Season Lookup (Arcs)
    for arc in data.get('arcs', []):
        season_lookup[arc['part']] = arc

    # Build Episode Lookup (Caching)
    episodes_data = data.get('episodes', {})
    for key in episodes_data:
        ep = episodes_data[key]
        # Skip specials if arc is 0 (optional, matching your TS logic)
        if ep['arc'] == 0:
            continue

        ep_id = create_episode_id_string(ep['arc'], ep['episode'])
        episode_lookup[ep_id] = {
            'title': ep.get('title'),
            'description': ep.get('description', ''),
            'chapters': ep.get('chapters', ''),
            'episodes': ep.get('episodes', ''),
            'released': ep.get('released'),
            'episode': ep['episode'],
            'season': ep['arc']
        }

    print("-> Caching complete")

    try:
        plex = PlexServer(PLEX_URL, PLEX_TOKEN)
        show = plex.library.section(LIBRARY_NAME).get(SHOW_NAME)
        print("-> Connected to Plex")
    except Exception as e:
        print(f"Error connecting to Plex: {e}")
        return

    print("-> Updating metadata for One Pace")
    for season in show.seasons():
        season_index = season.seasonNumber

        # Skip Season 0/Specials if they aren't in your lookup
        if season_index not in season_lookup:
            continue

        season_data = season_lookup[season_index]
        season_description = season_data['description']
        season_summary = f"{season_description}\n\nSaga: {season_data['saga']}"
        try:
            season.edit(**{
                "title.value": season_data['title'],
                "title.locked": 1,
                "summary.value": season_summary,
                "summary.locked": 1,
            })
        except Exception as ex:
            print(f"  [!] Failed to update Season {season_index} metadata")

        episodes = season.episodes();

        print(f"  Season {season_index}: {season_data['title']} - {len(episodes)} Episodes")

        for episode in episodes:
            # PlexAPI provides seasonEpisode in 'sXXeXX' format by default
            episode_id = episode.seasonEpisode

            parsed_data = episode_lookup.get(episode_id)
            if not parsed_data:
                continue

            # Construct Summary following your TS pattern
            desc = parsed_data['description'].strip()
            chaps = parsed_data['chapters'].strip()
            orig_eps = parsed_data['episodes'].strip()

            summary = f"{desc}\n\nManga Chapter(s): {chaps}\nOriginal Anime Episode(s): {orig_eps}"

            # Apply Edits
            try:
                episode.edit(**{
                    "title.value": parsed_data['title'],
                    "title.locked": 1,
                    "summary.value": summary,
                    "summary.locked": 1,
                    "originallyAvailableAt.value": parsed_data['released'],
                    "originallyAvailableAt.locked": 1 if parsed_data['released'] else 0
                })
                # print(f"    - {episode_id.upper()}: {parsed_data['title']}")
            except Exception as e:
                print(f"    [!] Failed to update {episode_id}: {e}")

    show.refresh()
    print("-> Done")

if __name__ == "__main__":
    sync_one_pace()