namespace Satellite.Depots;

/// <summary>A depot, as this satellite knows it.</summary>
public sealed record Depot(
    string Id,
    string TenantId,
    string Name,
    string Region,
    int CapacityPallets,
    int UsedPallets,
    string Status)
{
    /// <summary>Utilisation as a whole percentage, floored.</summary>
    public int UtilisationPercent =>
        CapacityPallets == 0 ? 0 : (int)Math.Floor(UsedPallets * 100.0 / CapacityPallets);
}

/// <summary>
/// The satellite's data, scoped by tenant on every read.
/// </summary>
/// <remarks>
/// Every method takes a tenant and filters by it. Not because the hub is
/// expected to send the wrong one, but because the whole point of putting
/// authorization in the satellite is that it holds when the hub is wrong —
/// and a repository that trusts its caller quietly moves the boundary back.
/// </remarks>
public sealed class DepotRepository(IReadOnlyList<Depot> depots)
{
    public IReadOnlyList<Depot> List(string tenantId) =>
        [.. depots.Where(depot => depot.TenantId == tenantId).OrderBy(depot => depot.Name)];

    public Depot? Get(string tenantId, string depotId) =>
        depots.FirstOrDefault(depot => depot.TenantId == tenantId && depot.Id == depotId);

    /// <summary>How many depots sit in each status, for the dashboard tiles.</summary>
    public IReadOnlyDictionary<string, int> StatusSummary(string tenantId) =>
        List(tenantId)
            .GroupBy(depot => depot.Status)
            .ToDictionary(group => group.Key, group => group.Count());

    /// <summary>Closes a depot. Returns the new state, or null if it is not this tenant's.</summary>
    public Depot? Close(string tenantId, string depotId, string reason)
    {
        var index = depots.ToList().FindIndex(d => d.TenantId == tenantId && d.Id == depotId);
        if (index < 0) return null;

        var updated = depots[index] with { Status = "closed" };
        Replace(index, updated);
        _ = reason;
        return updated;
    }

    private void Replace(int index, Depot depot)
    {
        if (depots is List<Depot> mutable) mutable[index] = depot;
    }

    /// <summary>Two tenants, so the isolation test has something to prove.</summary>
    public static List<Depot> Seed() =>
    [
        new("dep-1", "acme", "Zürich Central", "CH", 1200, 1140, "at-capacity"),
        new("dep-2", "acme", "Rotterdam North", "NL", 3000, 1450, "open"),
        new("dep-3", "acme", "Lyon South", "FR", 800, 210, "open"),
        new("dep-4", "acme", "Hamburg East", "DE", 1500, 0, "closed"),
        new("dep-9", "globex", "Osaka Bay", "JP", 2000, 900, "open"),
    ];
}
