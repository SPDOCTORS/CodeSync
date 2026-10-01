# CodeSync Repair Roadmap

## Goal

Produce and verify one real LeetCode Accepted-submission commit in the existing `SPDOCTORS/Competitive-Programming` repository, without clearing existing extension data or recreating the repository.

## Smallest repair plan (approval required before implementation)

1. Add a supported backend start command and a secret-safe startup/readiness procedure. It must use the current OAuth client secret from the process environment, not source files or output.
2. Change the settings sign-in sequence so it saves a normalized backend URL without verifying an already-selected repository before OAuth. After authentication, verify and persist the existing repository, then resume the existing queue.
3. Add narrow regression coverage for the reordered authentication/repository-selection flow and the startup command or documented readiness check.
4. Rebuild, reload the unpacked extension without clearing storage, start the backend with the current environment values, sign in, and explicitly select/verify `SPDOCTORS/Competitive-Programming`.
5. Inspect existing queue diagnostics, retry only existing failed submissions if applicable, or submit one new Accepted LeetCode solution. Verify the backend reports the successful contents API write and confirm one new `LeetCode/.../<submission-id>.*` file and commit in GitHub.

## Non-goals

- No repository recreation, storage reset, queue deletion, secret exposure, or new platform support.
- No claim that historical import or unit tests prove a real GitHub commit.
