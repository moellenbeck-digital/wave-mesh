import { canManage, type Member, type Membership, type Wave, type WaveInvite } from "@/lib/control";
import { formatDate } from "@/lib/format";

const ROLE_NAMES: Record<Wave["role"], string> = {
  owner: "Eigentümer",
  admin: "Administrator",
  member: "Mitglied",
};

/**
 * Everything here is a plain form posting to the control server. It is the same
 * origin for the browser -- the control server proxies these pages -- so the
 * session cookie comes along, and none of it needs JavaScript.
 */
function MemberRow({ member, wave, mayRemove }: { member: Member; wave: Wave; mayRemove: boolean }) {
  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-2 py-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <span className="block truncate font-medium text-navy text-body-sm">
          {member.email ?? member.name ?? member.userId}
        </span>
        {member.email && member.name ? (
          <span className="block truncate text-caption text-slate">{member.name}</span>
        ) : null}
      </div>

      <div className="text-caption text-slate">{ROLE_NAMES[member.role]}</div>

      <div className="text-caption text-slate">
        {member.nodeCount} {member.nodeCount === 1 ? "Gerät" : "Geräte"}
      </div>

      <div className="md:text-right">
        {mayRemove ? (
          <form method="post" action={`/waves/${wave.id}/members/${member.userId}/remove`}>
            <button type="submit" className="wc-btn wc-btn-secondary">
              Entfernen
            </button>
          </form>
        ) : (
          <span className="text-caption text-slate" title={formatDate(member.joinedAt)}>
            dabei seit {formatDate(member.joinedAt).split(",")[0]}
          </span>
        )}
      </div>
    </li>
  );
}

function InviteRow({ invite, wave }: { invite: WaveInvite; wave: Wave }) {
  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-2 py-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <span className="block truncate font-medium text-navy text-body-sm">{invite.email}</span>
        <span className="block text-caption text-slate">eingeladen, noch nicht beigetreten</span>
      </div>

      <div className="text-caption text-slate">{ROLE_NAMES[invite.role]}</div>

      <div className="text-caption text-slate">bis {formatDate(invite.expiresAt)}</div>

      <div className="md:text-right">
        <form method="post" action={`/waves/${wave.id}/invites/${invite.id}/revoke`}>
          <button type="submit" className="wc-btn wc-btn-secondary">
            Zurückziehen
          </button>
        </form>
      </div>
    </li>
  );
}

export function MemberList({ wave, membership }: { wave: Wave; membership: Membership }) {
  const manage = canManage(membership.role);

  return (
    <>
      <ul className="divide-y divide-line">
        {membership.members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            wave={wave}
            // The owner stays: a wave without one could not be administered.
            // And only the owner decides about the other administrators.
            mayRemove={
              manage && member.role !== "owner" && (membership.role === "owner" || member.role === "member")
            }
          />
        ))}
        {membership.invites.map((invite) => (
          <InviteRow key={invite.id} invite={invite} wave={wave} />
        ))}
      </ul>

      {manage ? (
        <form
          method="post"
          action={`/waves/${wave.id}/invites`}
          className="mt-6 flex flex-col gap-3 border-line border-t pt-6 md:flex-row md:items-end"
        >
          <div className="flex-1">
            <label className="wc-label" htmlFor={`invite-email-${wave.id}`}>
              Jemanden einladen
            </label>
            <input
              className="wc-input"
              id={`invite-email-${wave.id}`}
              name="email"
              type="email"
              placeholder="name@example.com"
              autoComplete="off"
              required
            />
          </div>

          <div>
            <label className="wc-label" htmlFor={`invite-role-${wave.id}`}>
              Rolle
            </label>
            <select className="wc-input" id={`invite-role-${wave.id}`} name="role" defaultValue="member">
              <option value="member">Mitglied</option>
              <option value="admin">Administrator</option>
            </select>
          </div>

          <button type="submit" className="wc-btn wc-btn-primary">
            Einladen
          </button>
        </form>
      ) : null}

      {manage ? (
        <p className="mt-3 text-caption text-slate">
          Die Einladung wird als Link ausgegeben — es wird keine E-Mail verschickt. Wer entfernt wird,
          verliert seine Geräte in diesem Wave.
        </p>
      ) : null}
    </>
  );
}
