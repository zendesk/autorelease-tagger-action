let child_process = require('child_process')

function sh() {
	let args = Array.prototype.slice.call(arguments)
	console.log("+ " + args.join(' '))
	let result = child_process.spawnSync(args[0], args.slice(1), {
		encoding: 'utf8',
		stdio: ['inherit', 'pipe', 'inherit']
	})
	// console.log(result)
	if (result.status != 0) {
		throw new Error("Command failed: " + args.join(' '))
	}
	return result.stdout.trim('\n')
}

function renderVersion(v) {
	return "v" + v.join('.')
}

function extendTo(length, array) {
	if (array.length > length) {
		throw new Error("input array is too long: " + JSON.stringify(array))
	}
	array = array.slice()
	while(array.length < length) {
		array.push(0)
	}
	return array
}

function initialVersion(opts) {
	return extendTo(opts.numComponents, [])
}

function nextVersion(opts, current, action) {
	if (!action.release) return null
	let bumpIdx = action.bump
	if (bumpIdx < opts.maximumBump) {
		throw new Error("Index "+bumpIdx+" is left of the maximum bump index ("+opts.maximumBump+")")
	}
	let version = current.slice(0, bumpIdx)
	if (current.length <= bumpIdx) {
		throw new Error("Tried to bump index " + bumpIdx + " of version with only "+ current.length + " components")
	}
	version.push(current[bumpIdx]+1)
	return extendTo(opts.numComponents, version)
}

function parsePart(p) {
	let digits = p.match(/^[0-9]+/)
	if (digits == null) {
		throw new Error("Invalid version component: " + p)
	}
	return parseInt(digits[0], 10)
}

function parseVersion(v) {
	if (v[0] == 'v') {
		let parts = v.slice(1).split('.')
		return parts.map(parsePart)
	} else {
		throw new Error("Invalid version string: " + v)
	}
}

function parseGitDescribe(output) {
	parts = output.trim().split('-')
	if (parts.length == 1) {
		// just a git commit
		return null
	} else if (parts.length > 2) {
		// output is e.g. v1.3.0-3-gf32721e
		let tag = parts.slice(0, parts.length - 2).join('-')
		return {
			tag: tag,
			version: parseVersion(tag)
		}
	} else {
		throw new Error("Unexpected `git describe` output: " + output)
	}
}

function commitLinesSince(tag) {
	// TODO
	return sh("git log --format=format:'%s' ${current}..HEAD")
}

let bumpAliases = ["major", "minor", "patch", "build"]

function parseBumpAlias(alias) {
	switch (alias) {
		case "major": return 0
		case "minor": return 1
		case "patch": return 2
		default: throw new Error("Invalid bump alias: " + alias)
	}
}

function parseCommitLines(opts, commitLines) {
	let alwaysRelease = opts.releaseTrigger == 'always'
	function parse(label) {
		let withoutRelease = label.replace(/ release$/, "")
		if (bumpAliases.includes(withoutRelease)) {
			return {
				bump: parseBumpAlias(withoutRelease),
				release: (withoutRelease != label)
			}
		} else {
			return {
				bump: null,
				release: (label == 'release')
			}
		}
	}

	let lines = commitLines.split("\n").filter((line) => line.length > 0)
	if (lines.length == 0) {
		return { release: false, bump: null }
	}
	let labels = (lines
		.map((line) => line.split(":"))
		.filter((line) => line.length > 1)
		.map((line) => parse(line[0]))
	)

	let doRelease = Boolean(opts.releaseTrigger == 'always' || labels.find((desc) => desc.release))
	let bumps = labels.map((d) => d.bump).filter((x) => x != null).sort((a,b) => a - b)
	return {
		release: doRelease,
		bump: bumps.length > 0 ? bumps[0] : opts.defaultBump
	}
}

function parseOpts(env) {
	function map(key, fn, dfl) {
		if (env.hasOwnProperty(key)) {
			return fn(env[key])
		} else {
			return dfl === undefined ? null : dfl
		}
	}
	function orElse(key, dfl) {
		return map(key, (x) => x, dfl)
	}
	function validate(key, dfl, fn) {
		let v = orElse(key, dfl)
		if (fn(v)) {
			return v
		} else {
			throw new Error("invalid "+key+": " + v)
		}
	}


	return {
		numComponents: map('numComponents', (i) => parseInt(i), 3),
		releaseTrigger: validate("releaseTrigger", "always", (x) => ["always", "commit"].includes(x)),
		defaultBump: parseBumpAlias(orElse("defaultBump", "minor")),
		maximumBump: parseBumpAlias(orElse("maximumBump", "major")),
		doTag: validate("doTag", "true", (x) => ["true","false"].includes(x)) === "true",
		doPush: validate("doPush", "true", (x) => ["true","false"].includes(x)) === "true",
	}
}

function getNextVersion(opts) {
	let describeOutput = sh("git describe --tags -match 'v*' --always --long HEAD")
	console.log("Git describe output: "+ describeOutput)
	let current = parseGitDescribe(describeOutput)
	if (current == null) {
		console.log("No current version detected")
		return initialVersion(opts)
	} else {
		console.log("Current version: " + renderVersion(current.version) + " (from tag "+current.tag+")")
	}
	let action = parseCommitLines(commitLinesSince(current.tag))
	return nextVersion(current.version, action)
}

function applyVersion(opts, version) {
	let tag = renderVersion(version)
	console.log("Applying version "+ tag)
	console.log("::set-output name=versionTag::"+tag)
	if (opts.doTag) {
		sh("git tag ${tag} HEAD")
		if (opts.doPush) {
			sh("git push tag ${tag}")
		}
	}
}

exports.main = function() {
	let opts = parseOpts(process.env)
	let nextVersion = getNextVersion(opts)
	if (nextVersion != null) {
		applyVersion(opts, nextVersion)
	} else {
		console.log("No version release triggered")
	}
}

exports.test = function() {
	function assertEq(a,b) {
		let aDesc = JSON.stringify(a)
		let bDesc = JSON.stringify(b)
		if(aDesc !== bDesc) {
			throw new Error("Expected "+ bDesc + ", got "+ aDesc)
		}
	}

	function assertThrows() {
		let args = Array.prototype.slice.call(arguments)
		let fn = args.shift()
		let msg = args.pop()
		let threw = false
		try {
			fn.apply(null, args)
		} catch(e) {
			threw = true
			assertEq(e.message, msg)
		}
		if (!threw) {
			throw new Error("Function didn't fail")
		}
	}

	assertEq(parsePart("08"), 8)
	assertEq(parsePart("1-rc2"), 1)
	assertThrows(parsePart, "v1", "Invalid version component: v1")
	assertThrows(parsePart, "", "Invalid version component: ")

	assertEq(parseVersion("v1.2.3"), [1,2,3])
	assertEq(parseVersion("v1"), [1])
	assertThrows(parseVersion, "1", "Invalid version string: 1")

	assertEq(parseGitDescribe("v1.2.3-1-gabcd"), { tag: "v1.2.3", version: [1,2,3]})
	assertEq(parseGitDescribe("v1.2-rc1.3-1-gabcd"), { tag: "v1.2-rc1.3", version: [1,2,3] })
	assertEq(parseGitDescribe("gabcd"), null)
	assertThrows(parseGitDescribe, "v1.2-gabcd", "Unexpected `git describe` output: v1.2-gabcd")

	let defaultOpts = parseOpts({})
	let manualRelease = { releaseTrigger: 'commit', defaultBump: 1 }
	function assertParseCommitLines(lines, expected, opts) {
		if (!opts) { opts = defaultOpts }
		assertEq(parseCommitLines(opts, lines.join("\n")), expected)
	}
	assertParseCommitLines([], { release: false, bump: null })
	assertParseCommitLines(["major: thing"], { release: true, bump: 0 })
	assertParseCommitLines(["minor: thing"], { release: true, bump: 1 })
	assertParseCommitLines(["patch: thing"], { release: true, bump: 2 })
	assertParseCommitLines(["other: thing"], { release: true, bump: 1 })
	assertParseCommitLines(["other: thing"], { release: false, bump: 1 }, manualRelease)
	assertParseCommitLines(["release: thing"], { release: true, bump: 1 }, manualRelease)
	assertParseCommitLines(["major release: thing"], { release: true, bump: 0 }, manualRelease)

	assertParseCommitLines(["release: thing", "minor: woo"], { release: true, bump: 1 }, manualRelease)
	assertParseCommitLines(["minor: woo", "major: woo"], { release: true, bump: 0 })
	assertParseCommitLines(["minor: woo", "patch: woo"], { release: true, bump: 1 })

	assertEq(nextVersion(defaultOpts, [1,2,3], { release: true, bump: 0 }), [2,0,0])
	assertEq(nextVersion(defaultOpts, [1,2,3], { release: true, bump: 1 }), [1,3,0])
	assertEq(nextVersion(defaultOpts, [1,2,3], { release: true, bump: 2 }), [1,2,4])
	assertThrows(nextVersion, defaultOpts, [1,2,3], { release: true, bump: 3 }, "Tried to bump index 3 of version with only 3 components")
	assertThrows(nextVersion, {maximumBump: 1}, [1,2,3], { release: true, bump: 0 }, "Index 0 is left of the maximum bump index (1)")

	assertEq(parseOpts({}), {
		numComponents:3,
		releaseTrigger:"always",
		defaultBump:1,
		"maximumBump":0,
		doTag:true,
		doPush:true
	})

	assertEq(parseOpts({
		releaseTrigger: 'commit',
		defaultBump: 'major',
		maximumBump: 'patch',
		doTag: 'true',
		doPush: 'false',
	}), {
		numComponents: 3,
		releaseTrigger: "commit",
		defaultBump: 0,
		maximumBump: 2,
		doTag: true,
		doPush: false
	})

	assertEq(sh("echo", "1", "2"), "1 2")
	assertThrows(sh, "cat", "/ does_not_exist", "Command failed: cat / does_not_exist")
}
