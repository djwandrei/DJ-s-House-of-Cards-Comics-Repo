#!/usr/bin/env python3
"""Upsert authoritative non-legacy rows and hard-delete obsolete Supabase rows."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import requests


USER_AGENT = "codex-authoritative-listings-sync/1.0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--env-file",
        default=r"C:\Users\djwan\Downloads\codex_account_keys.env",
    )
    parser.add_argument(
        "--upsert-file",
        default="outputs/authoritative-listings-supabase-upsert.json",
    )
    parser.add_argument(
        "--delete-file",
        default="outputs/authoritative-listings-delete-ids.json",
    )
    parser.add_argument("--output-dir", default="outputs")
    parser.add_argument("--chunk-size", type=int, default=75)
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args()


def load_env(path: Path) -> None:
    if not path.exists():
        raise RuntimeError(f"Credential file does not exist: {path}")
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


def chunks(values: list[Any], size: int) -> Iterable[list[Any]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def request_headers(key: str, prefer: str | None = None) -> dict[str, str]:
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def raise_for_response(response: requests.Response, action: str) -> None:
    if response.ok:
        return
    body = response.text[:1000]
    raise RuntimeError(f"{action} failed with HTTP {response.status_code}: {body}")


def fetch_ids(
    base_url: str, key: str, ids: list[int], columns: str = "*", chunk_size: int = 75
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for batch in chunks(ids, chunk_size):
        response = requests.get(
            f"{base_url}/rest/v1/products",
            headers=request_headers(key),
            params={
                "select": columns,
                "id": f"in.({','.join(str(value) for value in batch)})",
                "order": "id.asc",
            },
            timeout=90,
        )
        raise_for_response(response, "Supabase fetch")
        rows.extend(response.json())
    return rows


def fetch_all_remote_identity(
    base_url: str, key: str, page_size: int = 1000
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        response = requests.get(
            f"{base_url}/rest/v1/products",
            headers={**request_headers(key), "Range": f"{offset}-{offset + page_size - 1}"},
            params={"select": "id,name,metadata,is_deleted", "order": "id.asc"},
            timeout=120,
        )
        raise_for_response(response, "Supabase identity scan")
        page = response.json()
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return rows


def is_nonlegacy_remote(row: dict[str, Any]) -> bool:
    metadata = row.get("metadata")
    return isinstance(metadata, dict) and isinstance(metadata.get("excelFields"), dict)


def exact_count(base_url: str, key: str) -> int:
    response = requests.get(
        f"{base_url}/rest/v1/products",
        headers={**request_headers(key, "count=exact"), "Range": "0-0"},
        params={"select": "id"},
        timeout=90,
    )
    raise_for_response(response, "Supabase count")
    content_range = response.headers.get("Content-Range", "")
    if "/" not in content_range:
        raise RuntimeError(f"Supabase count returned no exact Content-Range: {content_range}")
    return int(content_range.rsplit("/", 1)[1])


def normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def verify_rows(
    expected_rows: list[dict[str, Any]], remote_rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    expected_by_id = {int(row["id"]): row for row in expected_rows}
    remote_by_id = {int(row["id"]): row for row in remote_rows}
    mismatches: list[dict[str, Any]] = []
    for product_id, expected in expected_by_id.items():
        remote = remote_by_id.get(product_id)
        if remote is None:
            mismatches.append({"id": product_id, "reason": "missing"})
            continue
        differing = [
            key
            for key, expected_value in expected.items()
            if normalize(remote.get(key)) != normalize(expected_value)
        ]
        if differing:
            mismatches.append({"id": product_id, "reason": "field-mismatch", "fields": differing})
    return mismatches


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    load_env(Path(args.env_file))
    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

    expected_rows = json.loads(Path(args.upsert_file).read_text(encoding="utf-8"))
    manifest_delete_ids = [
        int(value) for value in json.loads(Path(args.delete_file).read_text(encoding="utf-8"))
    ]
    target_ids = [int(row["id"]) for row in expected_rows]
    target_id_set = set(target_ids)
    output_dir = Path(args.output_dir)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    before_count = exact_count(base_url, key)
    remote_identity = fetch_all_remote_identity(base_url, key)
    remote_nonlegacy_ids = {
        int(row["id"]) for row in remote_identity if is_nonlegacy_remote(row)
    }
    remote_nonlegacy_outside_authority = sorted(remote_nonlegacy_ids - target_id_set)
    delete_ids = sorted(set(manifest_delete_ids) | set(remote_nonlegacy_outside_authority))
    deletion_backup = fetch_ids(base_url, key, delete_ids, chunk_size=args.chunk_size)
    write_json(
        output_dir / f"supabase-authoritative-delete-backup-{timestamp}.json",
        deletion_backup,
    )

    if args.apply:
        for batch in chunks(expected_rows, args.chunk_size):
            response = requests.post(
                f"{base_url}/rest/v1/products",
                headers=request_headers(key, "resolution=merge-duplicates,return=minimal"),
                params={"on_conflict": "id"},
                json=batch,
                timeout=120,
            )
            raise_for_response(response, "Supabase upsert")
        for batch in chunks(delete_ids, args.chunk_size):
            response = requests.delete(
                f"{base_url}/rest/v1/products",
                headers=request_headers(key, "return=minimal"),
                params={"id": f"in.({','.join(str(value) for value in batch)})"},
                timeout=90,
            )
            raise_for_response(response, "Supabase hard delete")

    remote_targets = fetch_ids(
        base_url,
        key,
        target_ids,
        columns=",".join(expected_rows[0].keys()),
        chunk_size=args.chunk_size,
    )
    remaining_deletions = fetch_ids(
        base_url, key, delete_ids, columns="id", chunk_size=args.chunk_size
    )
    mismatches = verify_rows(expected_rows, remote_targets)
    after_count = exact_count(base_url, key)
    report = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "applied": args.apply,
        "beforeRemoteCount": before_count,
        "afterRemoteCount": after_count,
        "expectedAuthoritativeRows": len(expected_rows),
        "remoteAuthoritativeRows": len(remote_targets),
        "manifestDeleteIds": len(manifest_delete_ids),
        "remoteNonlegacyRows": len(remote_nonlegacy_ids),
        "remoteNonlegacyOutsideAuthority": len(remote_nonlegacy_outside_authority),
        "deleteIdsRequested": len(delete_ids),
        "deleteRowsBackedUp": len(deletion_backup),
        "remainingDeleteIds": [int(row["id"]) for row in remaining_deletions],
        "mismatchCount": len(mismatches),
        "mismatches": mismatches,
    }
    write_json(output_dir / "supabase-authoritative-sync-report.json", report)
    print(
        json.dumps(
            {
                key: value
                for key, value in report.items()
                if key not in {"mismatches", "remainingDeleteIds"}
            }
            | {
                "remainingDeleteIdCount": len(report["remainingDeleteIds"]),
                "mismatchSample": mismatches[:10],
            },
            indent=2,
        )
    )
    if args.apply and (
        len(remote_targets) != len(expected_rows)
        or remaining_deletions
        or mismatches
    ):
        raise RuntimeError("Supabase verification failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
