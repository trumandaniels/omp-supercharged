#!/usr/bin/env python3
"""Run deterministic evidence-harness skill checks and its focused tool contract test."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[4]
SKILL_ROOT = REPO / "skills" / "evidence-harness"
EVAL_ROOT = Path(__file__).resolve().parent
SOURCE_MANIFEST_PATH = SKILL_ROOT / "references" / "source-manifest.json"
DEVELOPMENT_ROOT = EVAL_ROOT.parent / "development"
REQUIRED_CATEGORIES = {
    "routing-positive",
    "routing-negative",
    "typical",
    "boundary",
    "failure",
    "out-of-scope",
}
REQUIRED_HEADINGS = {
    "core rule",
    "scope",
    "required inputs and preconditions",
    "source policy",
    "workflow",
    "decision rules",
    "verification",
    "recovery",
    "termination",
    "output",
}


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"{path} must contain an object")
    return value


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def headings(markdown: str) -> set[str]:
    return {
        match.group(1).strip().lower()
        for match in re.finditer(r"^#{2,3}\s+(.+?)\s*$", markdown, re.MULTILINE)
    }


def validate_core(markdown: str) -> list[str]:
    failures: list[str] = []
    frontmatter = markdown.split("---", 2)
    if len(frontmatter) < 3:
        failures.append("missing frontmatter")
    else:
        metadata = frontmatter[1]
        for field in ("name: evidence-harness", "description:", "version: 0.1.0"):
            if field not in metadata:
                failures.append(f"missing frontmatter field: {field}")
    missing_headings = REQUIRED_HEADINGS - headings(markdown)
    if missing_headings:
        failures.append(f"missing headings: {sorted(missing_headings)}")
    invariants = (
        "the task has one clear contract or reproduced defect",
        "references exist",
        "Natural-language self-review is not verification",
        "A falsified hypothesis cannot become selected",
        "Do not use when",
    )
    lowered = markdown.lower()
    for invariant in invariants:
        if invariant.lower() not in lowered:
            failures.append(f"missing invariant: {invariant}")
    return failures


def main() -> int:
    failures: list[str] = []
    skill_path = SKILL_ROOT / "SKILL.md"
    reference_path = SKILL_ROOT / "references" / "tool-contract.md"
    skill = skill_path.read_text(encoding="utf-8")
    reference = reference_path.read_text(encoding="utf-8")
    failures.extend(validate_core(skill))
    source_manifest = load_json(SOURCE_MANIFEST_PATH)
    if source_manifest.get("skill") != "evidence-harness":
        failures.append("source manifest names the wrong skill")
    if source_manifest.get("skill_version") != "0.1.0":
        failures.append("source manifest version differs from the skill")
    manifest_sources = source_manifest.get("sources")
    if not isinstance(manifest_sources, list) or not manifest_sources:
        failures.append("source manifest needs a nonempty sources array")
        manifest_sources = []
    manifest_paths: set[str] = set()
    for source in manifest_sources:
        if not isinstance(source, dict):
            failures.append("source manifest entries must be objects")
            continue
        relative_path = source.get("path")
        expected_hash = source.get("sha256")
        locators = source.get("locators")
        if (
            not isinstance(relative_path, str)
            or Path(relative_path).is_absolute()
            or ".." in Path(relative_path).parts
        ):
            failures.append(f"invalid source manifest path: {relative_path!r}")
            continue
        source_path = REPO / relative_path
        manifest_paths.add(relative_path)
        if not source_path.is_file():
            failures.append(f"source manifest path missing: {relative_path}")
            continue
        if expected_hash != sha256(source_path):
            failures.append(f"source snapshot hash differs: {relative_path}")
        if not isinstance(locators, list) or not locators:
            failures.append(f"source manifest needs locators: {relative_path}")
            continue
        source_text = source_path.read_text(encoding="utf-8")
        for locator in locators:
            if not isinstance(locator, str) or locator not in source_text:
                failures.append(
                    f"source locator does not resolve: {relative_path}#{locator}"
                )


    scenarios = load_json(EVAL_ROOT / "scenarios.json").get("scenarios")
    if not isinstance(scenarios, list):
        failures.append("scenarios must be an array")
        scenarios = []
    categories = {
        item.get("category") for item in scenarios if isinstance(item, dict)
    }
    if categories != REQUIRED_CATEGORIES:
        failures.append(
            f"scenario categories differ: missing={sorted(REQUIRED_CATEGORIES - categories)} extra={sorted(categories - REQUIRED_CATEGORIES)}"
        )
    for item in scenarios:
        if not isinstance(item, dict) or not item.get("request") or not item.get("assertions"):
            failures.append("every scenario needs a request and assertions")

    extraction = load_json(EVAL_ROOT / "extraction" / "cases.json")
    for case in extraction.get("cases", []):
        for term in case.get("required_terms", []):
            if term not in reference:
                failures.append(f"extraction term absent from reference: {term}")

    provenance = load_json(EVAL_ROOT / "provenance" / "cases.json")
    for case in provenance.get("cases", []):
        source_manifest_path = case.get("source_manifest")
        if (
            not isinstance(source_manifest_path, str)
            or REPO / source_manifest_path != SOURCE_MANIFEST_PATH
        ):
            failures.append("provenance case does not bind the source manifest")
        declared_sources = {
            source for source in case.get("sources", []) if isinstance(source, str)
        }
        if declared_sources != manifest_paths:
            failures.append("provenance sources differ from the source manifest")
        for source in case.get("sources", []):
            if not (REPO / source).is_file():
                failures.append(f"provenance source missing: {source}")
            if source not in reference:
                failures.append(f"reference omits provenance source: {source}")

    retrieval = load_json(EVAL_ROOT / "retrieval" / "cases.json")
    combined_routing_text = f"{skill.split('---', 2)[1]}\n{skill}".lower()
    for case in retrieval.get("cases", []):
        for signal in case.get("signals", []):
            if signal.lower() not in combined_routing_text:
                failures.append(f"routing signal absent: {signal}")

    citations = load_json(EVAL_ROOT / "citations" / "cases.json")
    for case in citations.get("cases", []):
        for locator in case.get("required_locators", []):
            if not (REPO / locator).is_file() or locator not in reference:
                failures.append(f"citation locator does not resolve: {locator}")

    mutations = load_json(EVAL_ROOT / "mutations" / "cases.json").get("cases", [])
    for case in mutations:
        mutated = skill
        if "remove" in case:
            mutated = mutated.replace(case["remove"], "", 1)
        elif "replace" in case:
            old, new = case["replace"]
            mutated = mutated.replace(old, new, 1)
        elif "remove_heading" in case:
            mutated = mutated.replace(f"## {case['remove_heading']}", "## Removed", 1)
        if not validate_core(mutated):
            failures.append(f"mutation survived validation: {case.get('id')}")

    tool_test = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--test",
            "--test-name-pattern=hypotheses require real evidence",
            "tests/adaptive.test.ts",
        ],
        cwd=REPO,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=120,
        check=False,
    )
    if tool_test.returncode != 0:
        failures.append(f"focused hypothesis tool test failed:\n{tool_test.stdout}")

    report = {
        "schema_version": 1,
        "kind": "evidence_harness_skill_evaluation",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "skill_version": "0.1.0",
        "skill_sha256": sha256(skill_path),
        "reference_sha256": sha256(reference_path),
        "source_manifest_sha256": sha256(SOURCE_MANIFEST_PATH),
        "scenario_count": len(scenarios),
        "mutation_count": len(mutations),
        "focused_tool_test_exit_code": tool_test.returncode,
        "success": not failures,
        "failures": failures,
    }
    DEVELOPMENT_ROOT.mkdir(parents=True, exist_ok=True)
    report_path = DEVELOPMENT_ROOT / "latest-report.json"
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, sort_keys=True))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
