using System.Text.RegularExpressions;
using Digdir.Domain.Dialogporten.Application.Features.V1.Common.Localizations;
using Digdir.Domain.Dialogporten.Domain.Common;
using FluentValidation;
using HtmlAgilityPack;

namespace Digdir.Domain.Dialogporten.Application.Common.Extensions.FluentValidation;

internal static partial class FluentValidationStringExtensions
{
    private static readonly string[] AllowedTags = [
        "p", "a", "br", "em", "strong", "ul",
        "ol", "li", "table", "thead",
        "tbody", "tr", "td", "th"];

    private static readonly string ContainsValidHtmlError =
        "Value contains unsupported HTML. The following tags are supported: " +
        $"[{string.Join(",", AllowedTags.Select(x => '<' + x + '>'))}]. Tag attributes " +
        "are not supported except for on '<a>' which must contain a 'href' starting " +
        "with 'https://'.";

    public static IRuleBuilderOptions<T, string?> IsValidUri<T>(this IRuleBuilder<T, string?> ruleBuilder) =>
        ruleBuilder
            .Must(uri => uri is null || Uri.IsWellFormedUriString(uri, UriKind.RelativeOrAbsolute))
            .WithMessage("'{PropertyName}' is not a well-formatted URI.");

    /// <summary>
    /// LOCAL DEVELOPMENT ONLY — do not merge upstream.
    /// Altinn Studio LocalTest serves apps over plain http on local.altinn.cloud:8000 and builds
    /// absolute redirect URLs from the incoming Host header, so putting it behind a TLS proxy makes
    /// it drop the port and bounce the user to the wrong origin. To let dialogs link back into a
    /// locally running app, plain http is accepted for loopback and known local hosts.
    /// Gated on ASPNETCORE_ENVIRONMENT=Development, so deployed environments are unaffected.
    /// </summary>
    private static readonly bool AllowLocalHttpUrls =
        string.Equals(
            Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT"),
            "Development",
            StringComparison.OrdinalIgnoreCase);

    private static bool IsAcceptableUrl(Uri uri)
    {
        if (uri.Scheme == Uri.UriSchemeHttps)
        {
            return true;
        }

        if (!AllowLocalHttpUrls || uri.Scheme != Uri.UriSchemeHttp)
        {
            return false;
        }

        return uri.IsLoopback
               || uri.Host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
               || uri.Host.Equals("local.altinn.cloud", StringComparison.OrdinalIgnoreCase);
    }

    public static IRuleBuilderOptions<T, string?> IsValidHttpsUrl<T>(this IRuleBuilder<T, string?> ruleBuilder) =>
        ruleBuilder
            .Must(x => x is null || (Uri.TryCreate(x, UriKind.Absolute, out var uri) && IsAcceptableUrl(uri)))
            .WithMessage("'{PropertyName}' is not a well-formatted HTTPS URL.");

    public static IRuleBuilderOptions<T, Uri?> IsValidHttpsUrl<T>(this IRuleBuilder<T, Uri?> ruleBuilder) =>
        ruleBuilder
            .Must(x => x is null || (x.IsAbsoluteUri && IsAcceptableUrl(x)))
            .WithMessage("'{PropertyName}' is not a well-formatted HTTPS URL.");

    public static IRuleBuilderOptions<T, LocalizationDto> ContainsValidHtml<T>(
        this IRuleBuilder<T, LocalizationDto> ruleBuilder) =>
        ruleBuilder
            .Must(x => x.Value is null || x.Value.HtmlAgilityPackCheck())
            .WithMessage(ContainsValidHtmlError);

    [GeneratedRegex(
        "^(?:urn:altinn:(?:[a-z][a-z0-9_-]*):)?[a-z][a-z0-9_-]*$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase | RegexOptions.NonBacktracking)]
    private static partial Regex ValidAuthorizationAttributeRegex();

    public static IRuleBuilderOptions<T, string?> IsValidAuthorizationAttribute<T>(
        this IRuleBuilder<T, string?> ruleBuilder)
    {
        return ruleBuilder
            .MaximumLength(Constants.DefaultMaxStringLength)
            .Must(value => value is null || ValidAuthorizationAttributeRegex().IsMatch(value))
            .WithMessage("'{PropertyName}' must be on format 'urn:altinn:{resourcetype}:{resourcename}' or " +
                         "{resourcename} with valid names (letters, digits, '-' or '_', starting with a letter).");
    }

    private static bool HtmlAgilityPackCheck(this string html)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);
        var nodes = doc.DocumentNode.DescendantsAndSelf();
        foreach (var node in nodes)
        {
            if (node.NodeType != HtmlNodeType.Element) continue;

            if (!AllowedTags.Contains(node.Name))
            {
                return false;
            }

            // If the node is a hyperlink, it should only have a href attribute,
            // and it must start with 'https://'
            if (node.IsAnchorTag())
            {
                if (!node.IsValidAnchorTag())
                {
                    return false;
                }

                continue;
            }

            if (node.Attributes.Count > 0)
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsAnchorTag(this HtmlNode node)
    {
        const string anchorTag = "a";
        return node.Name == anchorTag;
    }

    private static bool IsValidAnchorTag(this HtmlNode node)
    {
        const string https = "https://";
        const string href = "href";
        return node.Attributes.Count == 1 &&
               node.Attributes[href] is not null &&
               node.Attributes[href].Value.StartsWith(https, StringComparison.InvariantCultureIgnoreCase);
    }
}
