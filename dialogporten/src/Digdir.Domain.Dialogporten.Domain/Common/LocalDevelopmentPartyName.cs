namespace Digdir.Domain.Dialogporten.Domain.Common;

/// <summary>
/// Reads party display names out of a dialog's external reference, for local development.
/// </summary>
/// <remarks>
/// Dialogporten has no way to resolve these names on its own: the local party name registry
/// answers with a fixed placeholder for every identifier, and Altinn Studio LocalTest only
/// answers lookups for parties it registered itself. Tools that import local test data therefore
/// append the owner's name to the external reference as "|owner={name}", and this reads it back.
/// <para>
/// The external reference is used rather than a service owner label or search tag because those
/// entities lowercase their value, which would turn "DDG Fitness" into "ddg fitness".
/// </para>
/// </remarks>
public static class LocalDevelopmentPartyName
{
    private const string OwnerMarker = "|owner=";

    /// <summary>Returns the embedded owner name, or null when the reference carries none.</summary>
    public static string? FromExternalReference(string? externalReference)
    {
        if (externalReference is null)
        {
            return null;
        }

        var index = externalReference.IndexOf(OwnerMarker, StringComparison.Ordinal);
        if (index < 0)
        {
            return null;
        }

        var name = externalReference[(index + OwnerMarker.Length)..];
        return string.IsNullOrWhiteSpace(name) ? null : name;
    }

    /// <summary>The bare identifier, used when no name is known.</summary>
    public static string Fallback(string party)
    {
        var index = party.LastIndexOf(':');
        return index < 0 ? party : party[(index + 1)..];
    }
}
