namespace Digdir.Domain.Dialogporten.Domain.Parties;

/// <summary>
/// Local development escape hatch for party identifier validation.
/// </summary>
/// <remarks>
/// Synthetic test data does not generally carry valid MOD11 control digits. Altinn Studio
/// LocalTest, for example, ships parties such as 01039012345 (Sophie Salt) and 897069650
/// (DDG Fitness) that fail the check, which makes such data unusable as dialog parties.
/// <para>
/// When <see cref="SkipControlDigits"/> is set, identifiers are still required to have the
/// correct length and to contain only digits — only the control digit comparison is skipped.
/// </para>
/// <para>
/// This is wired exclusively from the development-only branch of
/// <c>InfrastructureExtensions.AddInfrastructure</c> and defaults to off, so it can never be
/// enabled in a deployed environment.
/// </para>
/// </remarks>
public static class PartyIdentifierValidation
{
    public static bool SkipControlDigits { get; set; }

    internal static bool IsAllDigits(ReadOnlySpan<char> value)
    {
        foreach (var character in value)
        {
            if (!char.IsAsciiDigit(character))
            {
                return false;
            }
        }

        return true;
    }
}
