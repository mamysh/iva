# Settling native Telegram questions (experimental)

Released Iva 0.4.11 does not implement this change. The experiment records the
message reference when the Telegram channel posts an `input.requested` question.
After Eve emits its authoritative `input.resolved` event, the channel removes all
choices and shows the accepted selection. This status does not claim that the
subsequent business operation succeeded.

The reference and accepted display status are part of persisted channel state.
If Telegram editing fails, the accepted answer remains accepted; only delivery is
retried when the turn completes or resumes. No business operation is replayed.
Rich previews are edited without their embedded button tags. Classic previews use
an empty inline keyboard; if text editing fails, keyboard removal is attempted
separately. UI delivery can still fail, so an old-looking preview is not evidence
that its action is available. Existing unresolved questions from before this change
have no recorded reference and cannot be retroactively edited.

Question text remains literal, including native ForceReply and long-message posting.
For long classic questions the recorded first message owns the keyboard; adding a
status can exceed Telegram's text limit, in which case only keyboard removal may
succeed. Freeform answers are never echoed in the status because they can contain
credentials or personal data.

Eve 0.51.1 already produces `input.resolved` but does not expose it in the public
channel-handler event list. This experiment adds that exposure through the existing
patch-package mechanism. An upstream implementation should add the same event to
Eve's public channel definition and Telegram event types rather than mutate a
compiled adapter at runtime. Normal question resolution still belongs to Eve.

Reverting to released Iva requires no data migration. Additional channel-state
fields are unused there, and automatic preview settling is unavailable again.
