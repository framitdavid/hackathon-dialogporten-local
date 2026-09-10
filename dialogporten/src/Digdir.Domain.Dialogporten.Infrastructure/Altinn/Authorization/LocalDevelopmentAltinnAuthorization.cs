using System.Diagnostics.CodeAnalysis;
using Digdir.Domain.Dialogporten.Application.Common.Authorization;
using Digdir.Domain.Dialogporten.Application.Common.Extensions;
using Digdir.Domain.Dialogporten.Application.Externals;
using Digdir.Domain.Dialogporten.Application.Externals.AltinnAuthorization;
using Digdir.Domain.Dialogporten.Domain.Common;
using Digdir.Domain.Dialogporten.Domain.Dialogs.Entities;
using Digdir.Domain.Dialogporten.Domain.Parties;
using Digdir.Domain.Dialogporten.Domain.Parties.Abstractions;
using Microsoft.EntityFrameworkCore;

namespace Digdir.Domain.Dialogporten.Infrastructure.Altinn.Authorization;

internal sealed class LocalDevelopmentAltinnAuthorization : IAltinnAuthorization
{
    // 123456789 fails the mod-11 check for Norwegian organization numbers. Arbeidsflate sends every
    // sub-party alongside the parent on each dialog search (getPartyIds in utils/dialog.ts), and a
    // single invalid party makes searchDialogs return null — an empty inbox with no error anywhere.
    // 123456785 is the same number carrying the correct control digit.
    /// <summary>
    /// A stable identifier per party. A fresh <see cref="Guid.NewGuid" /> per call would make the
    /// frontend unable to remember which actor the user picked, since the party it stores in a
    /// cookie no longer exists on the next request.
    /// </summary>
    private static Guid DeterministicUuid(string party)
        => new(System.Security.Cryptography.SHA256
            .HashData(System.Text.Encoding.UTF8.GetBytes(party))
            .AsSpan(0, 16));

    private static readonly string LocalSubParty = NorwegianOrganizationIdentifier.PrefixWithSeparator + "123456785";

    private readonly IDialogDbContext _db;

    public LocalDevelopmentAltinnAuthorization(IDialogDbContext db)
    {
        ArgumentNullException.ThrowIfNull(db);
        _db = db;
    }

    [SuppressMessage("Performance", "CA1822:Mark members as static")]
    public Task<DialogDetailsAuthorizationResult> GetDialogDetailsAuthorization(
        DialogEntity dialogEntity,
        CancellationToken __) =>
        // Allow everything, for every configured party
        Task.FromResult(new DialogDetailsAuthorizationResult
        {
            AuthorizedChecks = dialogEntity.GetAuthorizationChecks()
                .Select(AuthorizedCheck.FullyPermitted)
                .ToList()
        });

    public async Task<DialogSearchAuthorizationResult> GetAuthorizedResourcesForSearch(List<string> constraintParties, List<string> serviceResources,
        bool includeDialogIds = true,
        int? minResourcesPruningThreshold = null,
        CancellationToken cancellationToken = default)
    {

        // constraintParties and serviceResources are passed from the client as query parameters
        // If one and/or the other is supplied this will limit the resources and parties to the ones supplied
        var dialogData = await _db.Dialogs
            .Select(dialog => new { dialog.Party, dialog.ServiceResource })
            .WhereIf(constraintParties.Count != 0, dialog => constraintParties.Contains(dialog.Party))
            .WhereIf(serviceResources.Count != 0, dialog => serviceResources.Contains(dialog.ServiceResource))
            .Distinct()
            .ToListAsync(cancellationToken);

        // Keep the number of parties and resources reasonable
        var allParties = dialogData.Select(x => x.Party).Distinct().Take(1000).ToList();
        IReadOnlySet<string> allResources = dialogData.Select(x => x.ServiceResource).Distinct().Take(1000).ToHashSet();

        var authorizedResources = new DialogSearchAuthorizationResult
        {
            ResourcesByParties = allParties.ToDictionary(party => party, _ => allResources)
        };

        return authorizedResources;
    }

    /// <summary>
    /// The authenticated person, named after the dialogs it holds.
    /// </summary>
    /// <remarks>
    /// Without this the party switcher shows a fixed placeholder for everyone, which makes one
    /// local test user indistinguishable from the next. The name is read off the dialogs
    /// themselves — see <see cref="LocalDevelopmentPartyName"/> for why it lives there.
    /// </remarks>
    public async Task<AuthorizedPartiesResult> GetAuthorizedParties(
        IPartyIdentifier authenticatedParty,
        bool _ = false,
        CancellationToken cancellationToken = default)
    {
        // Read once for both the party and its sub party; a local database is small enough that
        // this costs nothing, and the alternative is two queries for the same rows.
        var namesByParty = (await _db.Dialogs
                .AsNoTracking()
                .Where(dialog => !dialog.Deleted)
                .Select(dialog => new { dialog.Party, dialog.ExternalReference })
                .ToListAsync(cancellationToken))
            .GroupBy(dialog => dialog.Party, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => group
                    .Select(dialog => LocalDevelopmentPartyName.FromExternalReference(dialog.ExternalReference))
                    .FirstOrDefault(name => name is not null),
                StringComparer.Ordinal);

        string NameOf(string party)
        {
            return namesByParty.GetValueOrDefault(party) ?? LocalDevelopmentPartyName.Fallback(party);
        }

        return new AuthorizedPartiesResult
        {
            AuthorizedParties = [new()
                {
                    Party = authenticatedParty.FullId,
                    PartyUuid = DeterministicUuid(authenticatedParty.FullId),
                    PartyId = 0,
                    Name = NameOf(authenticatedParty.FullId),
                    DateOfBirth = null,
                    PartyType = AuthorizedPartyType.Person,
                    IsDeleted = false,
                    HasKeyRole = false,
                    IsCurrentEndUser = true,
                    IsMainAdministrator = false,
                    IsAccessManager = false,
                    HasOnlyAccessToSubParties = false,
                    AuthorizedResources = [],
                    AuthorizedRolesAndAccessPackages = [],
                    AuthorizedInstances = [],
                    SubParties =
                    [
                        new()
                        {
                            Party = LocalSubParty,
                            PartyUuid = DeterministicUuid(LocalSubParty),
                            PartyId = 0,
                            Name = NameOf(LocalSubParty),
                            DateOfBirth = null,
                            PartyType = AuthorizedPartyType.Person,
                            IsDeleted = false,
                            HasKeyRole = false,
                            IsCurrentEndUser = true,
                            IsMainAdministrator = false,
                            IsAccessManager = false,
                            HasOnlyAccessToSubParties = false,
                            AuthorizedResources = [],
                            AuthorizedRolesAndAccessPackages = [],
                            AuthorizedInstances = [],
                            SubParties = null,
                            ParentParty = null
                        }
                    ],
                    ParentParty = null
                }
            ]
        };
    }

    public async Task<AuthorizedPartiesResult> GetAuthorizedPartiesForLookup(
        IPartyIdentifier authenticatedParty,
        List<string> constraintParties,
        CancellationToken cancellationToken = default)
    {
        var authorizedResources = await _db.Dialogs
            .AsNoTracking()
            .Select(x => x.ServiceResource)
            .Distinct()
            .Take(20)
            .ToListAsync(cancellationToken);

        var parties = (constraintParties.Count > 0
            ? constraintParties.Distinct(StringComparer.OrdinalIgnoreCase).ToList()
            : [authenticatedParty.FullId])
            .Concat([LocalSubParty])
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        return new AuthorizedPartiesResult
        {
            AuthorizedParties = parties
                .Select((party, index) => new AuthorizedParty
                {
                    Party = party,
                    PartyUuid = Guid.NewGuid(),
                    PartyId = index + 1,
                    Name = "Local Party",
                    DateOfBirth = null,
                    PartyType = AuthorizedPartyType.Person,
                    IsDeleted = false,
                    HasKeyRole = false,
                    IsCurrentEndUser = string.Equals(party, authenticatedParty.FullId, StringComparison.OrdinalIgnoreCase),
                    IsMainAdministrator = false,
                    IsAccessManager = false,
                    HasOnlyAccessToSubParties = false,
                    AuthorizedResources = [.. authorizedResources],
                    AuthorizedRolesAndAccessPackages = [],
                    AuthorizedInstances = []
                })
                .ToList()
        };
    }

    public Task<bool> HasListAuthorizationForDialog(DialogEntity _, CancellationToken __) => Task.FromResult(true);

    public bool UserHasRequiredAuthLevel(int minimumAuthenticationLevel) => true;
    public Task<bool> UserHasRequiredAuthLevel(string serviceResource, CancellationToken _) => Task.FromResult(true);
}
