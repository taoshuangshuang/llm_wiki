import json
import os
import pathlib
import sys
import time
import urllib.request

out = pathlib.Path(__file__).parent
name = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else 'standard'
top_k = int(sys.argv[3]) if len(sys.argv) > 3 else 5
question = sys.argv[4] if len(sys.argv) > 4 else 'imeta 是什么'
state = json.loads((pathlib.Path.home() / 'Library/Application Support/com.llmwiki.app/app-state.json').read_text())
token = os.environ.get('LLM_WIKI_API_TOKEN') or state.get('apiConfig', {}).get('token')
base = os.environ.get('LLM_WIKI_API_BASE_URL', 'http://127.0.0.1:19828/api/v1').rstrip('/')
payload = {'message': question, 'mode': mode, 'topK': top_k, 'includeContent': False,
           'persistSession': False, 'tools': {'wiki': True, 'web': False, 'anytxt': False}}
req = urllib.request.Request(base + '/projects/c5248ab7-9524-46b4-9477-be2dbe393c58/chat',
    data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
started = time.monotonic()
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=600) as response:
    raw = response.read()
result = json.loads(raw)
elapsed = round(time.monotonic() - started, 2)
(out / (name + '.raw.json')).write_bytes(raw)
compact = {'message': result.get('message'), 'references': [
    {k: r.get(k) for k in ('title', 'path', 'kind')} for r in result.get('references', [])], 'usage': result.get('usage')}
compact_raw = json.dumps(compact, ensure_ascii=False, indent=2).encode()
(out / (name + '.compact.json')).write_bytes(compact_raw)
summary = {'name': name, 'request': payload, 'seconds': elapsed, 'rawBytes': len(raw),
           'compactBytes': len(compact_raw), 'usage': result.get('usage'),
           'referencePaths': [r.get('path') for r in result.get('references', [])]}
(out / (name + '.metrics.json')).write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False))
print(result.get('message', {}).get('content', ''))
