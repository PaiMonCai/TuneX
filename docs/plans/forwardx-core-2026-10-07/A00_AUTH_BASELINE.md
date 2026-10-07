# A00 — auth hydration failure safety baseline

The batch-delete browser check previously observed a native form navigation before React had taken over the submit event. That observation did not prove the root cause was batch-delete code, hydration, HMR cross-origin development behavior, or another client failure.

One safety issue was independent of the root cause: the auth form did not declare a method, so an un-hydrated browser used HTML's default GET submission. Because the password input has a name, that can place credentials in the URL/query string.

This slice adds `method="post"` to the existing client form. Normal hydrated behavior is unchanged because `onSubmit` still calls `preventDefault()` and uses the existing API login/register flow. If hydration fails, the browser may still reach a non-functional POST route, but credentials are no longer placed into the URL by the default form method.

A small source-level regression test pins the static HTML safety property. This is **not** the browser acceptance for A00: localhost/production-build hydration, console/network evidence, real DB/Redis, and real Agent TCP/UDP/delete/restart cases remain pending.
