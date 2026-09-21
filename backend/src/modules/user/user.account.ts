// Account / data deletion (destructive — exact call args + ordering preserved).
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. The userDataCleanup helpers + auth-admin deleteUser call are
// invoked with identical args and ordering.

import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { deleteUserPrivateMemories } from "../../lib/memory/bulk";
import { dbJobsEnabled } from "../../lib/dbq/runner";
import {
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserAccountData,
    deleteUserProjects,
    listOrgsBlockingAccountDeletion,
    type AccountDeletionOrgBlocker,
} from "./user.dataCleanup";
import { type Db, errorMessage } from "./user.shared";

/**
 * Turn the sole-admin blockers into instructions the user can actually act
 * on. The two reasons need DIFFERENT actions — appointing a successor fixes
 * an org that still has members, and does nothing for an org whose only
 * problem is that it still owns matters — so a single "make another member
 * an admin" sentence sent the second group off to look for members who do
 * not exist. A mixed batch gets both sentences, each naming its own orgs.
 */
export function describeAccountDeletionBlockers(
    blockers: AccountDeletionOrgBlocker[],
): string {
    const named = (reason: AccountDeletionOrgBlocker["reason"]) =>
        blockers
            .filter((blocker) => blocker.reason === reason)
            .map((blocker) => blocker.name)
            .join(", ");
    const sentences: string[] = [];
    const withMembers = named("members");
    if (withMembers)
        sentences.push(
            `You are the only admin of ${withMembers}. Make another member an admin, or delete the organization, before deleting your account.`,
        );
    const withContent = named("content");
    if (withContent)
        sentences.push(
            `You are the only admin of ${withContent}, which still owns content. Delete or move the organization's projects, workflows, documents and reviews, or delete the organization, before deleting your account.`,
        );
    return sentences.join(" ");
}

export async function deleteUserAccount(
    db: Db,
    userId: string,
    userEmail: string | undefined,
    token: string | undefined,
): Promise<
    | { ok: true }
    | {
          ok: false;
          kind: "org_successor_required";
          blockers: AccountDeletionOrgBlocker[];
          error?: undefined;
      }
    | { ok: false; kind?: undefined; error: unknown }
> {
    try {
        // ORGANIZATIONS FIRST. An account that is the only admin of an
        // organization which still has members or content cannot be deleted:
        // promoting an arbitrary successor hands a firm's matters to whoever
        // joined first (and silently clears their `deny` overrides), while
        // removing the member outright is refused by
        // org_member_protect_resource_ownership and leaves the organization
        // memberless, invisible and undeletable. Answer 409 and let the user
        // choose a successor. This check runs BEFORE the enqueue so nothing
        // is scheduled, revoked, or destroyed.
        const blockers = await listOrgsBlockingAccountDeletion(db, userId);
        if (blockers.length > 0)
            return { ok: false, kind: "org_successor_required", blockers };

        // DATA FIRST, AUTH LAST — main's ordering, kept.
        //
        // documents.user_id references auth.users ON DELETE CASCADE (and
        // document_versions cascades from documents), so deleting the auth
        // user first destroys every row that records where this account's
        // files live. The cascade would then find nothing to clean up and
        // the objects would be orphaned in storage forever. The auth user
        // is therefore deleted by the job, as its final step, once the
        // data is actually gone.
        //
        // What the user experiences is unchanged: their sessions are
        // revoked here, immediately, so the account is unusable from the
        // moment this returns. The auth row lingering for the length of
        // the job is what makes the job's retries meaningful — a cascade
        // that permanently fails leaves a recoverable account instead of
        // an anonymous pile of rows.
        //
        // No runner on this process? Then a 202-style "it's queued" would
        // be a promise nothing can keep, so run the cascade inline —
        // exactly main's behaviour, which is still correct, just not
        // crash-durable.
        if (!dbJobsEnabled()) {
            console.warn(
                "[user/account] DB job runner disabled; deleting inline",
                { userId },
            );
            await deleteUserAccountData(db, userId, userEmail);
            const { error } = await db.auth.admin.deleteUser(userId);
            if (error) return { ok: false, error };
            return { ok: true };
        }

        // Enqueue BEFORE anything is destroyed: if this fails, nothing has
        // happened and the request is cleanly retriable.
        await enqueueDbJob(db, {
            kind: "account.delete",
            payload: { userId, userEmail: userEmail ?? null },
            dedupeKey: `account.delete:${userId}`,
            maxAttempts: 20,
        });

        // Best-effort session revocation. A failure here only means the
        // user keeps a valid token until the job deletes their auth user;
        // it must not fail a deletion that is already durably scheduled.
        if (token) {
            try {
                await db.auth.admin.signOut(token, "global");
            } catch (signOutErr) {
                console.error("[user/account] session revoke failed", {
                    userId,
                    error: errorMessage(signOutErr),
                });
            }
        }
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/account] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserChats(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserChats(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/chats] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserProjectsData(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserProjects(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/projects] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserTabularReviews(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserTabularReviews(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/tabular-reviews] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

/**
 * Wipe the user's app memory and the memories of private projects they
 * created. Organization and merely shared projects are intentionally outside
 * this account-level destructive action.
 */
export async function deletePrivateMemories(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserPrivateMemories(db, userId);
        return { ok: true };
    } catch (err) {
        console.error("[user/memories] delete failed", {
            userId,
            error: errorMessage(err),
        });
        return { ok: false, error: err };
    }
}
