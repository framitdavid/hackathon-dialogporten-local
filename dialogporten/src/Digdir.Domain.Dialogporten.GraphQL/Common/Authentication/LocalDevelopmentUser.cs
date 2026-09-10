using System.Security.Claims;
using System.Text.Json;
using Digdir.Domain.Dialogporten.Application.Common.Authorization;
using Digdir.Domain.Dialogporten.Application.Externals.Presentation;
using AuthConstants = Digdir.Domain.Dialogporten.Application.Common.Authorization.Constants;

namespace Digdir.Domain.Dialogporten.GraphQL.Common.Authentication;

internal sealed class LocalDevelopmentUser : IUser
{
    // Matches the value this class used before the pid became configurable.
    private const string DefaultPid = "03886595947";

    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly string _configuredPid;

    /// <summary>
    /// Stands in for a real end user in local development.
    /// </summary>
    /// <remarks>
    /// The pid is resolved per request, in this order:
    /// <list type="number">
    /// <item>the <c>pid</c> claim of the incoming bearer token, so whoever is signed in to the
    /// caller (arbeidsflate) is who Dialogporten acts as — no restart needed to switch user;</item>
    /// <item><c>LocalDevelopment:Pid</c> from configuration, used by the service owner API and
    /// other callers that carry no end user token;</item>
    /// <item><see cref="DefaultPid"/>.</item>
    /// </list>
    /// The token is decoded but deliberately not validated: nothing signs tokens locally.
    /// </remarks>
    public LocalDevelopmentUser(IHttpContextAccessor httpContextAccessor, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(httpContextAccessor);
        ArgumentNullException.ThrowIfNull(configuration);

        _httpContextAccessor = httpContextAccessor;
        _configuredPid = configuration["LocalDevelopment:Pid"] is { Length: > 0 } configured ? configured : DefaultPid;
    }

    public ClaimsPrincipal GetPrincipal() => BuildPrincipal(ResolvePid());

    private string ResolvePid() => PidFromBearerToken() ?? _configuredPid;

    private string? PidFromBearerToken()
    {
        var header = _httpContextAccessor.HttpContext?.Request.Headers.Authorization.ToString();
        if (string.IsNullOrEmpty(header) || !header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var parts = header["Bearer ".Length..].Split('.');
        if (parts.Length < 2)
        {
            return null;
        }

        try
        {
            var payload = Convert.FromBase64String(PadBase64Url(parts[1]));
            using var document = JsonDocument.Parse(payload);
            return document.RootElement.TryGetProperty("pid", out var pid) && pid.ValueKind == JsonValueKind.String
                ? pid.GetString()
                : null;
        }
        catch (Exception e) when (e is FormatException or JsonException)
        {
            return null;
        }
    }

    private static string PadBase64Url(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        return (padded.Length % 4) switch
        {
            2 => padded + "==",
            3 => padded + "=",
            _ => padded,
        };
    }

    private static ClaimsPrincipal BuildPrincipal(string pid) =>
        new(new ClaimsIdentity(
        [
            new Claim(ClaimTypes.Name, "Local Development User"),
            new Claim("acr", AuthConstants.IdportenLoaHigh),
            new Claim(ClaimTypes.NameIdentifier, "local-development-user"),
            new Claim("pid", pid),
            new Claim("scope", string.Join(" ", AuthorizationScope.AllScopes.Value)),
            new Claim("consumer",
                """
                {
                    "authority": "iso6523-actorid-upis",
                    "ID": "0192:991825827"
                }
                """)
        ]));
}
