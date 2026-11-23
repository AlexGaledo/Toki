# Devices and pairing

The user pairs a phone (over Tailscale) by scanning a QR code or typing an 8-character code; paired devices are listed and can be revoked. Notifications on this device can be switched on.

## Sub-features

- `pair-start` `Pair a phone` shows `Pairing QR code`, a code like `ABCD-EFGH`, a `timer` `Expires in m:ss`, the `Server address`, `New code`, `Done`.
- `pair-redeem` a phone redeems the code and appears under `Paired devices`.
- `pair-list` `Paired devices` list with `Paired <date> · last seen ...` and `Revoke`; empty `No devices yet`; `Refresh`.
- `pair-revoke` `Revoke` › `Unpair` marks a device `Revoked`; its next request is refused and it must pair again.
- `pair-notify` `Notifications on this device` switch.

## How to get to it (user POV)

- Sidebar `Pair a phone` (opens Settings on Devices).
- Profile menu › `Settings` › tab `Devices`.
- On the phone: open the server address, type the code in the `Pairing code` field.

## Driving it with control-toki

Preconditions:

- Baseline run; no paired devices.

- **Open.** `$C click --role button --name "Pair a phone" --exact --nth 0`. `dialog "Settings"` on `tabpanel "Devices"`, `No devices yet`.
- **Start pairing.** `$C click --role button --name "Pair a phone" --exact --in tabpanel:Devices`. `img "Pairing QR code"`, `Or type this code on the phone XXXX-XXXX`, `timer: Expires in 4:5x`. Read the code from `$C snapshot`.
- **Redeem (stands in for the phone).** `$C api POST /api/devices/pair '{"code":"XXXX-XXXX","name":"Verifier phone"}'` returns 200 and a `device` (its token prints as `<redacted>`).
- **Listed.** `$C click --role button --name Refresh --in tabpanel:Devices`. The list has `Verifier phone Paired <date> · last seen just now` and `Revoke`.
- **Second view.** `$C api GET /api/devices` lists `Verifier phone` with `"revoked": false`.
- **Revoke.** `$C click --role button --name Revoke --in tabpanel:Devices` shows `group "Unpair Verifier phone?"` with `Unpair now?`, `Unpair`, `Cancel`. `$C click --role button --name Unpair --exact`. The row stays, reading `Verifier phone Revoked Paired <date> ...` with no buttons; `api GET /api/devices` shows `"revoked": true`.
- **Proof.** `$C snapshot --path devices/paired.aria.yml`, `$C screenshot devices/paired.png`.

## Gotchas

- The redeem step goes through the API because the driver has one tab signed in with the hub token. That proves the hub and the desktop list, not the phone's `Pairing code` screen; report the phone UI as not covered.
- Codes expire after five minutes and are single use; `New code` makes another.
- The `Server address` defaults to the page origin (the vite port); a real phone needs Tailscale Serve (docs/SERVER.md).
- `Pair a phone` names two buttons (sidebar and panel): use `--in tabpanel:Devices` or `--nth`.
- Notifications need a service worker and browser permission; headless Chromium will not grant it, so `pair-notify` is BLOCKED here.
