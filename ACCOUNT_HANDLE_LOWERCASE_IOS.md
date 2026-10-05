# Lowercase account name / username — iOS notes

Backend change (2026-10-05). The iOS code is not in this repository, so this is a checklist. **No request or response shape changed**, and the backend enforces the rule whatever the app sends — an app that does nothing keeps working. The items below are UX polish so the user sees what the server will store.

## What the server does now

| Field | Where | Rule |
|---|---|---|
| Account name (login handle, `account`) | `POST /api/auth/register` | Trimmed and **lowercased** before storing. `Rajesh_Sharma` is stored and returned as `rajesh_sharma`. |
| Account availability | `POST /api/auth/accounts/validate {account}` | Case-insensitive: if `rajesh_sharma` exists, `Rajesh_Sharma`, `RAJESH_SHARMA`, `rAjEsH_sHaRmA` all answer `available:false`. |
| Login | `POST /api/auth/login {account}` | Exact spelling first, then case-insensitive. New accounts sign in with any casing. |
| Username (`@handle`) | `PATCH /api/v1/users/profiles/me {username}`, `GET /api/v1/users/usernames/validate?username=` | Already lowercased before (unchanged); now also unique ignoring case at the database. |
| Google / Apple sign-up | social auth endpoints | Generated account names were already lowercase; now also checked case-insensitively. |

Registration returns `409 AUTH_ACCOUNT_TAKEN` for any casing of a taken name — including the rare case where two people submit `Rajesh_Sharma` / `RAJESH_SHARMA` at the same instant (the database lets only one through). Previously that race could answer `409 AUTH_EMAIL_EXISTS`; it now always answers `AUTH_ACCOUNT_TAKEN`.

Display names (`firstName` / `lastName`), group names and community names are **not** affected.

## Existing users

Accounts created before this change keep the exact casing they were created with (e.g. `DhruvVasu`). They are not renamed. They still log in with their usual spelling, and with any other casing as long as no other legacy account shares the same lowercase form. Do **not** lowercase the account name the user types on the **login** screen — a few legacy accounts differ only by case and must type their exact spelling.

## Check on iOS

1. **Sign-up "Account name" field** — lowercase as the user types, pastes or autofills. Set `autocapitalizationType = .none` and `autocorrectionType = .no`, then in `textField(_:shouldChangeCharactersIn:replacementString:)` lowercase the replacement and keep the caret:

   ```swift
   func textField(_ tf: UITextField, shouldChangeCharactersIn range: NSRange,
                  replacementString string: String) -> Bool {
       let lower = string.lowercased(with: Locale(identifier: "en_US_POSIX"))
       guard lower != string else { return true }      // already lowercase
       guard tf.markedTextRange == nil else { return true } // IME composing
       guard let text = tf.text, let r = Range(range, in: text) else { return true }
       tf.text = text.replacingCharacters(in: r, with: lower)
       if let pos = tf.position(from: tf.beginningOfDocument,
                                offset: range.location + (lower as NSString).length) {
           tf.selectedTextRange = tf.textRange(from: pos, to: pos)
       }
       tf.sendActions(for: .editingChanged) // keep the ViewModel binding in step
       return false
   }
   ```

   Chain it with the existing length/charset checks.
2. **Edit profile "Username" field** — same handling.
3. **Login field** — leave as typed (see above).
4. After a successful register / profile save, render the `account` / `username` from the **response**, not the locally typed value, so a stale mixed-case copy is never shown (including any value cached in Keychain/GRDB for the login prefill).
5. Availability indicator: send what the user typed (already lowercased); the server answers case-insensitively either way.
6. Map `409 AUTH_ACCOUNT_TAKEN` on register to the same "already taken" message the availability check shows.

Use a fixed POSIX locale for lowercasing — the Turkish locale maps `I` to dotless `ı`, which the account charset rejects.
