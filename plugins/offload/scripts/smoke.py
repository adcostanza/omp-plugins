#!/usr/bin/env python3
"""Exercise /offload against a live omp RPC session without copying credentials."""
import hashlib
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path('/tmp/omp-offload-final') / f'run-{os.getpid()}'
SESSIONS = SCRATCH / 'sessions'
SESSIONS.mkdir(parents=True, exist_ok=True)
EXTENSION = ROOT / 'offload.ts'
PROBE = ROOT / 'scripts' / 'payload-probe.ts'
ISOLATION = ROOT / 'scripts' / 'isolation.yml'
THRESHOLD = ROOT / 'scripts' / 'compaction-probe.yml'
MODEL = os.environ.get('OFFLOAD_MODEL', 'anthropic/claude-haiku-4-5')
OMP = os.environ.get('OMP', 'omp')
BANKS = Path.home() / '.omp/agent/memories/mnemopi/banks'
OFFLOAD = 'offload'


def bank_state():
    if not BANKS.is_dir():
        return {}
    return {path.name: sorted(child.name for child in path.iterdir()) for path in BANKS.iterdir() if path.is_dir()}


def check_banks(label, expected):
    state = bank_state()
    print('MEMORY BANKS', label, sorted(state), flush=True)
    assert state == expected, 'User memory banks changed'


class RPC:
    def __init__(self, resume=None, config=None):
        argv = [OMP, '--mode', 'rpc', '--cwd', str(SCRATCH), '--session-dir', str(SESSIONS),
                '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '-e', str(EXTENSION),
                '-e', str(PROBE), '--config', str(ISOLATION), '--model', MODEL]
        if resume:
            argv.extend(['--config', str(THRESHOLD), '--resume', resume])
        if config:
            argv.extend(['--config', str(config)])
        env = os.environ.copy()
        env.pop('PI_CODING_AGENT_DIR', None)  # Use live auth; never copy or rotate a second credential DB.
        env['XDG_CONFIG_HOME'] = str(SCRATCH / 'xdg-config')
        env['XDG_DATA_HOME'] = str(SCRATCH / 'xdg-data')
        env['XDG_CACHE_HOME'] = str(SCRATCH / 'xdg-cache')
        self.p = subprocess.Popen(argv, cwd=SCRATCH, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1)
        self.events = queue.Queue()
        self.id = 0
        self.history_calls = []
        self.payloads = []
        self.compactions = []
        self.displays = []

        def reader():
            for line in self.p.stdout:
                try:
                    self.events.put(json.loads(line))
                except ValueError:
                    self.events.put({'type': 'invalid', 'line': line})
        threading.Thread(target=reader, daemon=True).start()
        self.expect(lambda event: event.get('type') == 'ready')

    def expect(self, pred, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=min(2, max(.01, deadline - time.monotonic())))
            except queue.Empty:
                if self.p.poll() is not None:
                    raise RuntimeError(f'omp exited {self.p.returncode}: {self.p.stderr.read()[-3000:]}')
                continue
            if event.get('type') in ('extension_error', 'invalid'):
                raise RuntimeError(event)
            if event.get('type') == 'extension_ui_request' and event.get('method') == 'notify':
                message = event.get('message', '')
                if message.startswith('offload payload '):
                    self.payloads.append(json.loads(message[len('offload payload '):]))
                elif message.startswith('offload display '):
                    self.displays.append(json.loads(Path(message[len('offload display '):]).read_text()))
                else:
                    print('NOTIFY', message, flush=True)
            if event.get('type') == 'tool_execution_start' and 'offloaded_history' in json.dumps(event.get('args', {})):
                self.history_calls.append(event)
                print('HISTORY TOOL', json.dumps(event.get('args', {}))[:200], flush=True)
            if event.get('type') in ('auto_compaction_start', 'auto_compaction_end'):
                self.compactions.append(event)
                print('AUTO', event.get('type'), event.get('aborted'), flush=True)
            if pred(event):
                return event
        raise TimeoutError('RPC event timeout')

    def send(self, kind, **kwargs):
        self.id += 1
        ident = f'r{self.id}'
        self.p.stdin.write(json.dumps({'id': ident, 'type': kind, **kwargs}) + '\n')
        self.p.stdin.flush()
        return ident

    def request(self, kind, **kwargs):
        ident = self.send(kind, **kwargs)
        result = self.expect(lambda event: event.get('type') == 'response' and event.get('id') == ident)
        assert result.get('success'), result
        return result['data']

    def prompt(self, message):
        ident = self.send('prompt', message=message)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            event = self.expect(lambda item: item.get('type') in ('response', 'prompt_result', 'agent_end') and
                                (item.get('type') == 'agent_end' or item.get('id') == ident),
                                timeout=max(1, deadline - time.monotonic()))
            if event.get('type') == 'response':
                assert event.get('success'), event
                if event.get('data', {}).get('agentInvoked') is False:
                    return ''
            elif event.get('type') == 'prompt_result':
                if event.get('agentInvoked') is False:
                    return ''
            elif event.get('isTerminal') is not False:
                return ' '.join(part.get('text', '') for item in event.get('messages', [])
                                if item.get('role') == 'assistant' for part in item.get('content', [])
                                if part.get('type') == 'text')
        raise TimeoutError('Prompt did not finish')

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=20)
        assert self.p.returncode == 0, self.p.stderr.read()[-3000:]


def entries(path):
    return [json.loads(line) for line in path.read_bytes().splitlines()]


def main():
    banks_before = bank_state()
    check_banks('before', banks_before)
    # A high keep-recent threshold deterministically makes native preparation decline.
    retain_all = SCRATCH / 'retain-all.yml'
    retain_all.write_text('compaction:\n  keepRecentTokens: 1000000\n')
    short = RPC(config=retain_all)
    try:
        short.prompt('Remember the short-session check. Reply only noted.')
        state = short.request('get_state')
        short_journal = Path(state['sessionFile'])
        short_before = short_journal.read_bytes()
        short.prompt('/offload')
        assert short_journal.read_bytes() == short_before, 'Native decline changed the journal'
        assert not any(entry.get('customType') == OFFLOAD or entry.get('customType') == OFFLOAD + '.cancelled'
                       for entry in entries(short_journal))
        print('SHORT native decline preserved journal and context', state['sessionId'], flush=True)
    finally:
        short.close()


    token = 'orchid-' + secrets.token_hex(8)
    checkpoint = 'kiwi-' + secrets.token_hex(6)
    os.environ['OFFLOAD_SENTINEL'] = token
    probe_dir = SCRATCH / 'probe'
    probe_dir.mkdir(exist_ok=True)
    os.environ['OFFLOAD_PROBE_DIR'] = str(probe_dir)
    print('SCRATCH', SCRATCH, 'MODEL', MODEL, 'EXTENSION', EXTENSION, flush=True)
    client = RPC()
    try:
        commands = client.request('get_available_commands')['commands']
        assert any(command['name'] == 'offload' for command in commands)
        print('SC1 command registered')
        client.prompt(f'The private retrieval sentinel is {token}. Remember it. ' + 'slate azure copper birch ' * 320 + 'Answer only noted.')
        last_reply = client.prompt(f'Checkpoint word: {checkpoint}. Reply with one short sentence that does not repeat the checkpoint word.').strip()
        assert last_reply and checkpoint not in last_reply
        reply_key = json.dumps(last_reply[:40])[1:-1]  # match JSON-escaped text in dumps
        state = client.request('get_state')
        journal = Path(state['sessionFile'])
        before = journal.read_bytes()
        client.prompt('/offload')
        after = journal.read_bytes()
        assert after.startswith(before)
        journal_entries = entries(journal)
        offloads = [entry for entry in journal_entries if entry['type'] == 'compaction' and entry.get('details', {}).get('kind') == OFFLOAD]
        assert len(offloads) == 1 and offloads[0]['tokensAfter'] < offloads[0]['tokensBefore']
        print('SC3 prefix', hashlib.sha256(before).hexdigest(), 'added', len(after) - len(before))
        details = offloads[0]['details']
        last_user = next(entry for entry in reversed(journal_entries) if entry['type'] == 'message' and entry['message']['role'] == 'user')
        # The final turn here starts with a user message (omp turn start) and fits keepRecentTokens.
        assert offloads[0]['firstKeptEntryId'] == last_user['id'], 'Cut does not start at the final turn start'
        assert any(entry.get('id') == details['markerId'] and entry.get('customType') == OFFLOAD for entry in journal_entries)
        # keptTokens comes from omp's own Tokenizer; it is absent only when that class is unreachable from the extension.
        assert 'below is kept verbatim' in offloads[0]['summary'] and details['keep'] == 'turn'
        assert 0 < details['keptTokens'] <= details['keepRecentTokens']
        print('CUT firstKeptEntryId=final turn start (user)', last_user['id'], 'marker', details['markerId'], 'nativeKeepId', details['nativeKeepId'],
              'tokensBefore', offloads[0]['tokensBefore'], 'tokensAfter', offloads[0]['tokensAfter'],
              'keptTokens', details['keptTokens'], 'keepRecentTokens', details['keepRecentTokens'], flush=True)
        client.prompt('/display-probe')
        display = client.displays[-1]
        for collapse in ('true', 'false'):
            shown = [json.dumps(message) for message in display[collapse]]
            divider = next(i for i, message in enumerate(display[collapse]) if message.get('role') == 'compactionSummary')
            above = '\n'.join(shown[:divider])
            assert checkpoint in above and reply_key in above, f'collapse={collapse}: last exchange not above divider'
            assert (token in above) == (collapse == 'false'), f'collapse={collapse}: earlier chat visibility wrong'
            print(f'DISPLAY collapseCompacted={collapse} messages', len(shown), 'divider at', divider,
                  'roles above', [message.get('role') for message in display[collapse][:divider]],
                  'earlier sentinel above', token in above, flush=True)
        client.prompt('/offload')
        assert len([entry for entry in entries(journal) if entry.get('customType') == OFFLOAD]) == 1
        print('NO-OP no second marker')
        answer = client.prompt('Without using any tools, what exact checkpoint word did I give in my previous message?')
        assert checkpoint in answer and not client.history_calls, (answer, client.history_calls)
        print('CONTINUITY answered from kept turn without offloaded_history:', answer[:120])
        post = next(payload for payload in client.payloads if payload['containsPointer'])
        # Stub summary + kept user + kept assistant + new prompt; the provider may merge adjacent user messages.
        assert post['containsSentinel'] is False and post['count'] <= 4
        messages = json.loads(Path(post['dump']).read_text())
        role_text = lambda role: json.dumps([m for m in messages if m.get('role') == role])
        assert '<history-offloaded>' in role_text('user') and 'offloaded_history' in role_text('user')
        assert checkpoint in role_text('user') and reply_key in role_text('assistant')
        print('SC2 first post-offload payload', post, 'roles', [m.get('role') for m in messages],
              'stub+last user+last reply present, sentinel absent', flush=True)
        state2 = client.request('get_state')
        assert state2['sessionId'] == state['sessionId'] and state2['sessionFile'] == str(journal)
    finally:
        client.close()
    resumed = RPC(resume=str(journal))
    try:
        resumed_state = resumed.request('get_state')
        assert resumed_state['sessionId'] == state['sessionId'] and resumed_state['sessionFile'] == str(journal)
        resumed.prompt('Reply only resumed.')
        assert resumed.payloads and resumed.payloads[0]['containsSentinel'] is False
        print('SC5 resume same session, cut retained', resumed.payloads[0])
        answer = resumed.prompt('What was the private retrieval sentinel? Find the exact value from earlier work.')
        assert token in answer and resumed.history_calls
        print('SC4 recovered', token, 'tool calls', len(resumed.history_calls))
        prior = len([entry for entry in entries(journal) if entry['type'] == 'compaction'])
        # Push post-offload context through 32K: previous history is excluded from accounting.
        for index in range(8):
            resumed.prompt(f'For this turn ({index}), analyze the following text in one short sentence: ' +
                           ('cedar spruce willow hazel ' * 1250))
            current = [entry for entry in entries(journal) if entry['type'] == 'compaction']
            native = [entry for entry in current[prior:] if entry.get('details', {}).get('kind') != OFFLOAD]
            if native:
                break
        assert native, 'No native auto compaction committed after post-offload growth'
        all_entries = entries(journal)
        keep_pos = next(index for index, entry in enumerate(all_entries) if entry.get('id') == offloads[0]['firstKeptEntryId'])
        assert all(next(index for index, entry in enumerate(all_entries) if entry.get('id') == comp['firstKeptEntryId']) > keep_pos for comp in native)
        assert journal.read_bytes().startswith(before)
        print('SC5 native auto compactions', len(native), 'kept after offload keep-start', True)
        answer = resumed.prompt('What was the private retrieval sentinel? Find the exact value from earlier work.')
        assert token in answer
        print('SC5 post-auto recovery', token)
    finally:
        resumed.close()
        check_banks('after', banks_before)
    print('PASS SC1-SC5')


if __name__ == '__main__':
    main()
