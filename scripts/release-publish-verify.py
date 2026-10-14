#!/usr/bin/env python3
"""Publisher-side data verification only; never extracts or executes release code."""
import argparse
import hashlib
import io
import json
import os
import re
import stat
import sys
import zipfile
import zlib

MAX = 300 * 1024 * 1024
HASH = re.compile(r'[0-9a-f]{64}\Z')
CHECKS = ['version', 'help', 'private-hook', 'private-route', 'mcp', 'storage-privacy', 'shutdown-and-reacquire', 'public-hook']
NATIVE_CHECKS = 'retainedStatementClose nativeWriterReacquired unfinishedFtsRollback authorizerDdlDenied callbackErrorIdentity asyncAuthorizerDenied authorizerReentryDenied authorizerIgnore invalidAuthorizerRecovery primitiveAuthorizerIdentity authorizerReplacementReprepare udf exactIntegers allIterateExactIntegers unsafeUdfArgumentDenied typedArrayBlobParity literalFilename literalBackupFilename backupNulDenied extensionDenied doubleQuotedStringsDenied onlineBackup backupTransferCleanupErrorIdentity partiallyRunningBackupClose noDelayedBackupWrites readonlyBackup immutableUri'.split()
NATIVE = 'node_modules/better-sqlite3/build/Release/bosun_sqlite.node'
PATCH = 'e1020d35775b701e8c186e0b5073a74b06232ec05f2f90fc99e2d79752007fbf'
PINS = [
    {'name': 'better-sqlite3', 'url': 'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz', 'sha256': '77e0513dc1a469fb3bceec4c7fb5ad3f403109787eda05be047ec17fd56868cb'},
    {'name': 'node-addon-api', 'url': 'https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.0.0.tgz', 'sha256': '49487860e4672b30f2bb5bfd5149ab51b5b98b44e321b2be9d4b77c2e7321b15'},
    {'name': 'node-api-headers', 'url': 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-headers.tar.gz', 'sha256': 'a60e5a543fab5e5105525948c596d4974c617f39606cef76eb94c3bf1df9a06c'},
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def decode(data, maximum=4 * 1024 * 1024):
    require(len(data) <= maximum, 'Oversized JSON')
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Invalid JSON number')))


def keys(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected), 'Unexpected JSON fields')


def safe(name):
    return isinstance(name, str) and 0 < len(name) < 512 and not re.search(r'[\\\x00-\x1f\x7f]', name) and all(part not in ('', '.', '..') for part in name.split('/'))


def read(directory, name, maximum=MAX):
    file = os.path.join(directory, name)
    before = os.lstat(file)
    require(stat.S_ISREG(before.st_mode) and os.path.realpath(file) == file and before.st_size <= maximum, 'Noncanonical or oversized asset')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        require((before.st_dev, before.st_ino, before.st_size) == (opened.st_dev, opened.st_ino, opened.st_size), 'Asset changed')
        data = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    require(len(data) == before.st_size and before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns, 'Asset changed')
    return data


def receipt(data, version, binary):
    value = decode(data, 1024 * 1024)
    keys(value, ['version', 'binarySha256', 'scope', 'checks', 'allJoined', 'liveHosts', 'liveModels', 'personalActivation'])
    require(value['version'] == version and value['binarySha256'] == binary and value['scope'] == 'compiled-local-release-safety', 'Qualification identity mismatch')
    require(value['allJoined'] is True and all(value[name] is False for name in ['liveHosts', 'liveModels', 'personalActivation']), 'Unsafe qualification scope')
    require(isinstance(value['checks'], list) and len(value['checks']) == len(CHECKS), 'Incomplete compiled checks')
    for check, name in zip(value['checks'], CHECKS):
        require(isinstance(check, dict) and check.get('name') == name and check.get('passed') is True and check.get('failed') is not True, 'Failed/missing compiled check')
    return value


def native(build, inventory):
    if 'nativeQualification' not in build:
        require(inventory[NATIVE]['sha256'] == '554a3ad6a9b55b8c91af529d7832c7c52605511c32a2833f352166a136046c1d', 'Unqualified native output')
        return
    embedded = build['nativeQualification']
    keys(embedded, ['sha256', 'receiptJson'])
    raw = embedded['receiptJson'].encode('utf-8')
    require(digest(raw) == embedded['sha256'], 'Native receipt checksum mismatch')
    value = decode(raw)
    keys(value, ['schema', 'coverage', 'trust', 'applicationAdmissionLifted', 'root', 'host', 'runtime', 'verifierInputs', 'output', 'provenance', 'probe'])
    keys(value['host'], ['platform', 'architecture', 'release', 'hostname'])
    keys(value['runtime'], ['version', 'executable'])
    keys(value['runtime']['executable'], ['path', 'realpath', 'sha256'])
    keys(value['output'], ['path', 'sha256', 'bytes'])
    keys(value['provenance'], ['sha256', 'json'])
    require(value['runtime']['executable']['path'] == value['runtime']['executable']['realpath'], 'Noncanonical native runtime')
    require(value['schema'] == 1 and value['coverage'] == 'native-library-smoke' and value['trust'] == 'trusted-workspace-not-hostile-same-user' and value['applicationAdmissionLifted'] is False, 'Invalid native admission evidence')
    require(value['host']['platform'] == 'darwin' and value['host']['architecture'] == 'arm64' and value['runtime']['version'] == '1.4.3' and value['runtime']['executable']['sha256'] == build['compiler']['sha256'], 'Native toolchain/runtime mismatch')
    require(value['output'] == {'path': NATIVE, 'sha256': inventory[NATIVE]['sha256'], 'bytes': inventory[NATIVE]['bytes']}, 'Native output inventory mismatch')
    require(digest(value['provenance']['json'].encode()) == value['provenance']['sha256'] == inventory[NATIVE.replace('.node', '.provenance.json')]['sha256'], 'Native provenance mismatch')
    expected = ['scripts/qualify-sqlite-native.mts', 'scripts/sqlite-native-inputs.mts', 'scripts/build-sqlite-native.mts', 'scripts/check-sqlite-library.mts', 'scripts/test-runtime.cjs', 'scripts/test-env.cjs']
    require([item['path'] for item in value['verifierInputs']] == expected, 'Native verifier inputs missing')
    for item in value['verifierInputs']:
        require(inventory[item['path']]['sha256'] == item['sha256'], 'Native verifier source mismatch')
    provenance = decode(value['provenance']['json'].encode())
    keys(provenance, ['schema', 'package', 'runtime', 'platform', 'architecture', 'napi', 'cxx', 'packageDir', 'archives', 'patch', 'inputFiles', 'toolchain', 'sdk', 'sandboxProfileSha256', 'environment', 'commands', 'qualification', 'output', 'status', 'buildMode', 'hostedToolchain'])
    require(provenance['schema'] == 1 and provenance['buildMode'] == 'hosted' and provenance['status'] == 'built-not-qualified' and provenance['qualification'] == 'not-run' and provenance['package'] == 'better-sqlite3@13.0.3' and provenance['runtime'] == 'Bun 1.4.3' and provenance['platform'] == 'darwin' and provenance['architecture'] == 'arm64' and provenance['napi'] == 10 and provenance['cxx'] == 'c++20', 'Invalid native provenance')
    require(provenance['output'] == value['output'] and provenance['packageDir'] == value['root'] + '/node_modules/better-sqlite3', 'Native provenance/output/root mismatch')
    hosted = provenance['hostedToolchain']
    keys(hosted, ['developerDir', 'toolchainRoot', 'xcrun', 'sdkSettings'])
    keys(hosted['xcrun'], ['path', 'realpath', 'sha256'])
    keys(hosted['sdkSettings'], ['path', 'realpath', 'sha256'])
    require(hosted['sdkSettings']['path'] == hosted['sdkSettings']['realpath'] == provenance['sdk'] + '/SDKSettings.json' and HASH.fullmatch(hosted['sdkSettings']['sha256']), 'Invalid hosted SDK settings evidence')
    require(re.fullmatch(r'/Applications/Xcode[^/]*\.app/Contents/Developer', hosted['developerDir']) and hosted['toolchainRoot'] == hosted['developerDir'] + '/Toolchains/XcodeDefault.xctoolchain' and hosted['xcrun']['path'] == hosted['xcrun']['realpath'] == '/usr/bin/xcrun' and HASH.fullmatch(hosted['xcrun']['sha256']), 'Invalid hosted Xcode evidence')
    require(provenance['sdk'].startswith(hosted['developerDir'] + '/Platforms/MacOSX.platform/Developer/SDKs/') and len(provenance['toolchain']) == 3, 'Invalid hosted SDK/toolchain')
    for tool, executable in zip(provenance['toolchain'], ['clang', 'clang++', 'ld']):
        keys(tool, ['path', 'realpath', 'sha256'])
        require(tool['path'] == hosted['toolchainRoot'] + '/usr/bin/' + executable and tool['realpath'].startswith(hosted['toolchainRoot'] + '/') and HASH.fullmatch(tool['sha256']), 'Invalid hosted toolchain paths')
    require(provenance['patch'] == {'path': 'patches/better-sqlite3@13.0.3.patch', 'sha256': PATCH}, 'Native patch mismatch')
    require(provenance['archives'] == [{'name': pin['name'], 'archiveSha256': pin['sha256']} for pin in PINS], 'Native archives mismatch')
    for item in provenance['inputFiles']:
        keys(item, ['name', 'sha256'])
        require(inventory['node_modules/better-sqlite3/' + item['name']]['sha256'] == item['sha256'], 'Native source mismatch')
    probe = value['probe']
    keys(probe, ['exitCode', 'signal', 'stdout', 'stdoutSha256', 'stderr', 'stderrSha256', 'sandboxProfile', 'sandboxProfileSha256'])
    require(len(probe['stdout'].encode()) <= 32 * 1024 and len(probe['stderr'].encode()) <= 32 * 1024 and len(probe['sandboxProfile'].encode()) <= 32 * 1024 and probe['sandboxProfile'].startswith('(version 1)\n'), 'Invalid native sandbox/report bounds')
    require(probe['exitCode'] == 0 and probe['signal'] is None, 'Native probe failed')
    for name in ['stdout', 'stderr', 'sandboxProfile']:
        require(digest(probe[name].encode()) == probe[name + 'Sha256'], 'Native probe checksum mismatch')
    report = decode(probe['stdout'].encode())
    keys(report, ['runtime', 'package', 'sqlite', 'selected', 'applicationAdmissionLifted'] + NATIVE_CHECKS)
    require(report['runtime'] == '1.4.3' and report['package'] == 'better-sqlite3@13.0.3' and report['selected'] == 'node_modules/better-sqlite3' and report['applicationAdmissionLifted'] is False and all(report.get(name) is True for name in NATIVE_CHECKS), 'Incomplete native probe')
    require(re.fullmatch(r'\d+\.\d+\.\d+', report['sqlite']), 'Invalid SQLite version evidence')
    major, minor, patch = map(int, report['sqlite'].split('.'))
    require(major == 3 and (minor > 51 or minor == 51 and patch >= 3 or minor == 50 and patch >= 7 or minor == 44 and patch >= 6), 'Native evidence lacks patched WAL engine')


def verify(directory, tag, commit):
    require(re.fullmatch(r'v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?', tag) and re.fullmatch(r'[0-9a-f]{40}', commit), 'Invalid expected tag/commit')
    require(os.path.realpath(directory) == directory and stat.S_ISDIR(os.lstat(directory).st_mode), 'Noncanonical release directory')
    version = tag[1:]
    archive = f'bosun-{version}-darwin-arm64.zip'
    original = f'bosun-{version}-darwin-arm64.tar.gz'
    names = sorted([archive, 'release.json', 'RELEASE_NOTES.md'])
    require(sorted(os.listdir(directory)) == sorted(names + ['SHA256SUMS']), 'Unexpected release assets')
    assets = {name: read(directory, name, 4 * 1024 * 1024 if name != archive else MAX) for name in names}
    require(read(directory, 'SHA256SUMS', 1024).decode() == ''.join(f'{digest(assets[name])}  {name}\n' for name in names), 'Top checksum mismatch')
    release = decode(assets['release.json'])
    keys(release, ['schema', 'product', 'tag', 'version', 'commit', 'target', 'runtimeQualification', 'compiledSafety', 'binarySha256', 'buildSha256', 'originalArchive', 'qualificationSha256', 'source', 'packages', 'members', 'assets'])
    require(release['schema'] == 1 and release['product'] == 'bosun' and release['tag'] == tag and release['version'] == version and release['commit'] == commit and release['target'] == 'bun-darwin-arm64' and release['runtimeQualification'] == 'unverified' and release['compiledSafety'] == 'passed', 'Release identity mismatch')
    require(release['assets'] == [{'name': name, 'bytes': len(assets[name]), 'sha256': digest(assets[name])} for name in [archive, 'RELEASE_NOTES.md']], 'Asset manifest mismatch')
    expected_source = {'project': f'https://github.com/vprodan/bosun/tree/{tag}', 'commit': commit, 'bun': {'version': '1.4.3', 'commit': 'c6da4a4d3', 'url': 'https://github.com/oven-sh/bun/tree/c6da4a4d3'}, 'sqlite': {'archives': PINS, 'patch': {'path': 'patches/better-sqlite3@13.0.3.patch', 'sha256': PATCH}, 'publicDomain': 'https://www.sqlite.org/copyright.html'}}
    require(release['source'] == expected_source, 'Source references mismatch')
    require(isinstance(release['members'], list) and len(release['members']) <= 1000, 'Invalid ZIP inventory')
    members = {}
    for item in release['members']:
        keys(item, ['path', 'bytes', 'sha256'])
        require(safe(item['path']) and item['path'] not in members and type(item['bytes']) is int and 0 < item['bytes'] <= MAX and HASH.fullmatch(item['sha256']), 'Invalid ZIP member metadata')
        members[item['path']] = item
    require(list(members) == sorted(members) and sum(item['bytes'] for item in members.values()) <= 600 * 1024 * 1024, 'ZIP inventory bounds/order mismatch')
    contents = {}
    with zipfile.ZipFile(io.BytesIO(assets[archive])) as bundle:
        require(len(bundle.infolist()) == len(members), 'Unexpected/duplicate ZIP members')
        for entry in bundle.infolist():
            require(entry.filename in members and entry.filename not in contents and not entry.is_dir() and not (entry.flag_bits & 1) and stat.S_IFMT(entry.external_attr >> 16) == stat.S_IFREG and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'Unsafe ZIP member')
            item = members[entry.filename]
            require(entry.file_size == item['bytes'], 'ZIP size mismatch')
            data = bundle.read(entry)
            require(digest(data) == item['sha256'], 'ZIP checksum mismatch')
            contents[entry.filename] = data
    mandatory = {'bosun', 'build.json', original, 'SHA256SUMS', 'qualification.json', 'LICENSE', 'THIRD_PARTY.json'}
    require(mandatory <= contents.keys() and all(name in mandatory or name.startswith('licenses/') for name in contents), 'Unexpected/missing ZIP files')
    require(release['binarySha256'] == digest(contents['bosun']) and release['buildSha256'] == digest(contents['build.json']) and release['qualificationSha256'] == digest(contents['qualification.json']) and release['originalArchive'] == {'name': original, 'sha256': digest(contents[original])}, 'Release hash bonds mismatch')
    receipt(contents['qualification.json'], version, release['binarySha256'])
    build = decode(contents['build.json'])
    expected_build = ['schema', 'product', 'version', 'target', 'compiler', 'flags', 'inputs', 'sourceDigest', 'dependenciesDigest', 'assetsDigest', 'binary', 'developmentDebugger', 'runtimeQualification']
    keys(build, expected_build + (['nativeQualification'] if 'nativeQualification' in build else []))
    require(build['schema'] == 1 and build['product'] == 'bosun' and build['version'] == version and build['target'] == 'bun-darwin-arm64' and build['runtimeQualification'] == 'unverified' and build['developmentDebugger'] == 'disabled-before-imports' and build['compiler']['version'] == '1.4.3' and HASH.fullmatch(build['compiler']['sha256']), 'Invalid original build metadata')
    flags = ['--compile', '--target=bun-darwin-arm64', '--format=esm', '--splitting', '--bytecode', '--minify', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json', '--define', 'process.env.DEV="false"', '--external', 'react-devtools-core']
    require(build['flags'] == flags and build['binary'] == {'bytes': len(contents['bosun']), 'sha256': release['binarySha256']}, 'Binary/compiler flags mismatch')
    inventory = {}
    require(isinstance(build['inputs'], list) and 0 < len(build['inputs']) <= 20000, 'Invalid build inputs')
    for item in build['inputs']:
        keys(item, ['path', 'bytes', 'sha256'])
        require(safe(item['path']) and item['path'] not in inventory and type(item['bytes']) is int and 0 <= item['bytes'] <= 32 * 1024 * 1024 and HASH.fullmatch(item['sha256']), 'Invalid build input')
        inventory[item['path']] = item
    require(list(inventory) == sorted(inventory) and sum(item['bytes'] for item in inventory.values()) <= 256 * 1024 * 1024, 'Build inventory bounds/order mismatch')
    for name, subset in [('sourceDigest', build['inputs']), ('dependenciesDigest', [item for item in build['inputs'] if item['path'].startswith('node_modules/')]), ('assetsDigest', [item for item in build['inputs'] if re.match(r'^(roles/|skills/|policy\.md$)', item['path'])])]:
        require(build[name] == digest(json.dumps(subset, separators=(',', ':'), ensure_ascii=False).encode()), 'Build inventory digest mismatch')
    require(inventory['patches/better-sqlite3@13.0.3.patch']['sha256'] == PATCH, 'Build patch mismatch')
    for pin, filename in zip(PINS, ['better-sqlite3.tgz', 'node-addon-api.tgz', 'node-api-headers.tgz']):
        require(inventory['.omp/tooling/sqlite-native-13.0.3/' + filename]['sha256'] == pin['sha256'], 'Build archive pin mismatch')
    native(build, inventory)
    distribution_names = sorted(['bosun', 'build.json', original])
    require(contents['SHA256SUMS'].decode() == ''.join(f'{digest(contents[name])}  {name}\n' for name in distribution_names), 'Original distribution checksums mismatch')
    binary = contents['bosun']
    require(len(binary) >= 32 and binary[:4] == b'\xcf\xfa\xed\xfe' and int.from_bytes(binary[4:8], 'little') == 0x100000c and int.from_bytes(binary[12:16], 'little') == 2, 'Not a Mach-O arm64 executable')
    inflater = zlib.decompressobj(31)
    tar = inflater.decompress(contents[original], len(binary) + 2049)
    require(inflater.eof and not inflater.unused_data and len(tar) <= len(binary) + 2048, 'Invalid/oversized original archive')
    header = bytearray(512)
    header[:5] = b'bosun'
    for value, offset, length in [(0o755, 100, 8), (0, 108, 8), (0, 116, 8), (len(binary), 124, 12), (0, 136, 12)]:
        header[offset:offset+length] = (format(value, 'o').zfill(length - 1) + '\0').encode()
    header[148:156] = b'        '
    header[156] = ord('0')
    header[257:263] = b'ustar\0'
    header[263:265] = b'00'
    header[148:156] = (format(sum(header), 'o').zfill(6) + '\0 ').encode()
    require(tar == bytes(header) + binary + bytes((-len(binary)) % 512 + 1024), 'Original archive framing/content mismatch')
    third = decode(contents['THIRD_PARTY.json'])
    keys(third, ['schema', 'source', 'packages', 'disclaimer'])
    require(third['schema'] == 1 and third['source'] == expected_source and third['packages'] == release['packages'] and 'Not a legal-clearance opinion' in third['disclaimer'], 'Third-party manifest mismatch')
    require(isinstance(release['packages'], list) and len(release['packages']) == 70, 'Incomplete production notice inventory')
    package_names = []
    licensed = set()
    for package in release['packages']:
        keys(package, ['name', 'version', 'source', 'files'])
        name, ver = package['name'], package['version']
        require(re.fullmatch(r'(?:@[a-z0-9._-]+/)?[a-z0-9._-]+', name) and re.fullmatch(r'[0-9A-Za-z.+-]+', ver) and package['source'] == f'https://registry.npmjs.org/{name}/-/{name.split("/")[-1]}-{ver}.tgz' and isinstance(package['files'], list) and package['files'], 'Invalid production notice mapping')
        require('node_modules/' + name + '/package.json' in inventory, 'Notice package absent from build')
        package_names.append(name)
        for file in package['files']:
            require(file in contents and file.startswith('licenses/packages/' + name + '/') and file not in licensed, 'Missing/duplicate dependency notice')
            licensed.add(file)
            original_notice = 'node_modules/' + file.removeprefix('licenses/packages/')
            if not (name == 'yoga-layout' and ver == '3.2.1' and file == 'licenses/packages/yoga-layout/LICENSE'):
                require(inventory[original_notice]['sha256'] == digest(contents[file]), 'Notice differs from build input')
    require(package_names == sorted(set(package_names)), 'Duplicate/unordered dependency inventory')
    for name in ['bun-LICENSE.md', 'yoga-LICENSE', 'RELINKING.md', 'LGPL-2.0.txt', 'LGPL-2.1.txt']:
        require('licenses/runtime/' + name in contents, 'Missing runtime license/relink document')
    require('LGPL' in contents['licenses/runtime/bun-LICENSE.md'].decode(), 'Missing runtime LGPL obligations')
    for name, data in contents.items():
        if name == 'LICENSE' or name.startswith('licenses/'):
            require(b'\0' not in data and data.decode('utf-8').strip(), 'Invalid/empty license text')
        if name.startswith('licenses/packages/'):
            require(name in licensed, 'Unmapped dependency notice')
    return {'tag': tag, 'commit': commit, 'archive': archive, 'binarySha256': release['binarySha256']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(os.path.abspath(args.directory), args.tag, args.commit), separators=(',', ':')))
    except (ValueError, KeyError, TypeError, OSError, UnicodeError, zipfile.BadZipFile, zlib.error) as error:
        print(f'Release verification failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
