using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using Digdir.Domain.Dialogporten.Domain.Common;
using Digdir.Domain.Dialogporten.Domain.Parties.Abstractions;

namespace Digdir.Domain.Dialogporten.Domain.Parties;

public sealed record NorwegianOrganizationIdentifier : IPartyIdentifier
{
    private static readonly int[] OrgNumberWeights = [3, 2, 7, 6, 5, 4, 3, 2];
    public static char ShortPrefix => 'o';
    public static string Prefix => "urn:altinn:organization:identifier-no";
    public static string PrefixWithSeparator => Prefix + PartyIdentifier.Separator;
    public string FullId { get; }
    public string Id { get; }

    private NorwegianOrganizationIdentifier(ReadOnlySpan<char> value)
    {
        Id = value.ToString();
        FullId = PrefixWithSeparator + Id;
    }

    public static bool TryParse(ReadOnlySpan<char> value, [NotNullWhen(true)] out IPartyIdentifier? identifier)
    {
        identifier = IsValid(value)
            ? new NorwegianOrganizationIdentifier(PartyIdentifier.GetIdPart(value))
            : null;
        return identifier is not null;
    }

    public static bool IsValid(ReadOnlySpan<char> value)
    {
        var idNumberWithoutPrefix = PartyIdentifier.GetIdPart(value);

        if (idNumberWithoutPrefix.Length != 9)
        {
            return false;
        }

        // Mod11 rejects non-digits, so an explicit digit check is only needed when skipping it.
        if (PartyIdentifierValidation.SkipControlDigits)
        {
            return PartyIdentifierValidation.IsAllDigits(idNumberWithoutPrefix);
        }

        return Mod11.TryCalculateControlDigit(idNumberWithoutPrefix[..8], OrgNumberWeights, out var control)
               && control == int.Parse(idNumberWithoutPrefix[8..9], CultureInfo.InvariantCulture);
    }
}
