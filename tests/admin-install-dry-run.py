"""Run the documented admin shell only against relocated files and command doubles.

No root access, production reads, sudo, or systemd operations are used.
"""
import pathlib, tempfile, shutil, re, subprocess, os, json
repo=pathlib.Path(__file__).resolve().parents[1]
os.chdir(repo)
(repo/".test-tmp").mkdir(exist_ok=True)
doc=(repo/'docs/CB-137-ROOT-UPDATER-GATE.md').read_text()
script=doc.split("sudo /bin/sh -eu <<'ADMIN'\n")[1].split('\nADMIN')[0]
scenarios = ['success', 'pending-request', 'maintenance', 'snapshot', 'active-updater', 'active-health', 'recover-running', 'app-inactive', 'tunnel-inactive', 'bad-journal', 'wrong-current', 'foreign-owner', 'writable-parent', 'symlink-payload', 'missing-runner', 'bad-sudoers', 'bad-unit', 'unit-drift']
for scenario in scenarios:
  with tempfile.TemporaryDirectory(dir=repo/'.test-tmp',prefix='admin-') as t:
    base=pathlib.Path(t); root=base/'root'; bin=base/'bin'; bin.mkdir()
    for d in ['usr/local/lib/codexbridge','etc/systemd/system','etc/sudoers.d','var/lib/codexbridge','var/backups','opt/codexbridge/releases/3a99deafb510a893e607204f3add8805599c69e7-1790617049303']:
        (root/d).mkdir(parents=True,exist_ok=True)
    for unit in (repo/'deploy/debian').glob('*.service'):
        historical = subprocess.check_output(['git', 'show', '3a99deaf:deploy/debian/'+unit.name])
        (root/'etc/systemd/system'/unit.name).write_bytes(historical)
    (root/'usr/local/lib/codexbridge/self-update.mjs').write_bytes(subprocess.check_output(['git','show','3a99deaf:scripts/self-update.mjs']))
    (root/'var/lib/codexbridge/update-status.json').write_text('{"phase":"completed"}')
    shutil.copyfile(repo/'deploy/debian/sudoers',root/'etc/sudoers.d/codexbridge')
    (root/'opt/codexbridge/current').symlink_to(root/'opt/codexbridge/releases/3a99deafb510a893e607204f3add8805599c69e7-1790617049303')
    relocated=script.replace('cd /var/lib/codexbridge/worktrees/CB-137','cd CHECKOUT_PLACEHOLDER')
    relocated=re.sub(r'/usr(?=[/ "\n])|/etc(?=[/ "\n])|/var(?=[/ "\n])|/opt(?=[/ "\n])',lambda m:str(root)+m[0],relocated)
    relocated=relocated.replace('CHECKOUT_PLACEHOLDER',str(repo))
    shim=bin/'shim'; log=base/'calls'
    shim.write_text('''#!/usr/bin/python3
import os,sys,json,subprocess
name=os.path.basename(sys.argv[0]); args=sys.argv[1:]; scenario=os.environ['SCENARIO']
with open(os.environ['DRY_LOG'],'a') as f:f.write(json.dumps([name,*args])+'\\n')
if name=='visudo' and scenario=='bad-sudoers': sys.exit(1)
if name=='systemd-analyze' and scenario=='bad-unit': sys.exit(1)
if name=='stat' and args[:2]==['-c','%u:%g']: print('1000:1000' if scenario=='foreign-owner' else '0:0')
elif name=='stat':
    mode=subprocess.check_output(['/usr/bin/stat','-c','%a',args[-1]],text=True).strip()
    print('0:0:'+mode)
elif name=='install':
    assert args[:6]==['-o','root','-g','root','-m','0644']
    assert args[-1].startswith(os.environ['DRY_ROOT']+'/')
    subprocess.run(['/usr/bin/install',*args[4:]],check=True)
elif name=='systemctl' and args[0]=='show':
    if '--value' in args:
        unit=args[1]; state='exited' if 'SubState' in args else ('active' if unit in ['codexbridge.service','codexbridge-tunnel.service'] else 'inactive')
        faults={'active-updater':('codexbridge-update.service','active'),'active-health':('codexbridge-recovery-health.service','active'),'recover-running':('codexbridge-recover.service','running'),'app-inactive':('codexbridge.service','inactive'),'tunnel-inactive':('codexbridge-tunnel.service','inactive')}
        if scenario in faults and faults[scenario][0]==unit: state=faults[scenario][1]
        print(state)
    else: print('simulated unchanged process state')
''')
    shim.chmod(0o755)
    for name in ['stat','install','systemctl','systemd-analyze','visudo']:(bin/name).symlink_to(shim)
    if scenario in ['pending-request','maintenance','snapshot']:
        name={'pending-request':'update-request.json','maintenance':'maintenance.json','snapshot':'rollback-snapshot.init-incomplete'}[scenario]
        (root/'var/lib/codexbridge'/name).write_text('sentinel')
    if scenario=='bad-journal': (root/'var/lib/codexbridge/update-status.json').write_text('{"phase":"activating"}')
    if scenario=='wrong-current':
        (root/'opt/codexbridge/current').unlink()
        (root/'opt/codexbridge/current').symlink_to(root/'opt/codexbridge/releases')
    if scenario=='writable-parent': (root/'usr/local/lib').chmod(0o777)
    if scenario=='symlink-payload':
        (root/'etc/systemd/system/codexbridge.service').unlink()
        (root/'etc/systemd/system/codexbridge.service').symlink_to(root/'missing')
    if scenario=='missing-runner': (root/'usr/local/lib/codexbridge/self-update.mjs').unlink()
    if scenario=='unit-drift': (root/'etc/systemd/system/codexbridge-update.service').write_text('unexpected')
    def snapshot():
        result={}
        for p in root.rglob('*'):
            rel=str(p.relative_to(root))
            if rel.startswith('var/backups/'): continue
            if p.is_symlink(): result[rel]=('link',os.readlink(p))
            elif p.is_file(): result[rel]=('file',p.read_bytes(),p.stat().st_mode & 0o777)
        return result
    before=snapshot()
    result=subprocess.run(['/bin/sh','-eu'],input=relocated,text=True,capture_output=True,env=dict(os.environ,PATH=str(bin)+':'+os.environ['PATH'],DRY_ROOT=str(root),DRY_LOG=str(log),SCENARIO=scenario))
    calls=[json.loads(s) for s in log.read_text().splitlines()]
    if scenario!='success':
        assert result.returncode!=0, scenario
        assert snapshot()==before, scenario
        assert not [c for c in calls if c[0]=='install' or (c[0]=='systemctl' and c[1]!='show')], scenario
        print('PASS abort before replacement:',scenario)
        continue
    assert result.returncode==0, result.stderr
    after=snapshot()
    changed={name for name in before.keys() | after.keys() if before.get(name)!=after.get(name)}
    assert changed=={'usr/local/lib/codexbridge/self-update.mjs','usr/local/lib/codexbridge/legacy-bootstrap.mjs','etc/systemd/system/codexbridge.service'}, changed
    for src,dst in [('scripts/self-update.mjs','usr/local/lib/codexbridge/self-update.mjs'),('scripts/legacy-bootstrap.mjs','usr/local/lib/codexbridge/legacy-bootstrap.mjs'),('deploy/debian/codexbridge.service','etc/systemd/system/codexbridge.service')]:
        assert (repo/src).read_bytes()==(root/dst).read_bytes()
        assert (root/dst).stat().st_mode & 0o777 == 0o644
    calls=[json.loads(s) for s in log.read_text().splitlines()]
    mutations=[c for c in calls if c[0]=='systemctl' and c[1]!='show']
    assert mutations==[['systemctl','daemon-reload']], mutations
    backups=list((root/'var/backups').iterdir()); assert len(backups)==1
    assert (backups[0]/'bootstrap-was-absent').exists()
    assert len([c for c in calls if c[0]=='install'])==3
    print('PASS: exact documented admin shell, relocated paths; three atomic replacements and backup, only mocked daemon-reload, unchanged current/process evidence.')
