import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import { 
  Camera, 
  Users, 
  Clock, 
  CheckCircle, 
  Calendar as CalendarIcon,
  AlertCircle,
  ArrowLeft,
  Building2,
  User,
  FileText,
  Star
} from "lucide-react";
import { Link } from "wouter";

interface FulfillmentTask {
  id: string;
  vendorId: string;
  businessId: string | null;
  taskType: string;
  sourceType: string;
  sourceId: string | null;
  status: string;
  assignedAdminId: string | null;
  scheduledDate: string | null;
  completedDate: string | null;
  isPriority: boolean;
  vendorNotes: string | null;
  adminNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FulfillmentStats {
  pending: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  total: number;
}

interface TaskDetails {
  task: FulfillmentTask;
  vendor: { id: string; name: string; email: string } | undefined;
  business: { id: string; name: string; category: string } | undefined;
  purchase?: { finalPriceInCents: number; paymentStatus: string };
  allowance?: { benefitId: string };
}

const taskTypeLabels: Record<string, string> = {
  product_shoot: "Product Shoot",
  lifestyle_shoot: "Lifestyle Shoot",
  influencer_promo: "Influencer Promo",
};

const statusLabels: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "secondary" },
  scheduled: { label: "Scheduled", variant: "outline" },
  in_progress: { label: "In Progress", variant: "default" },
  completed: { label: "Completed", variant: "outline" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

function TaskIcon({ taskType }: { taskType: string }) {
  switch (taskType) {
    case "product_shoot":
    case "lifestyle_shoot":
      return <Camera className="w-4 h-4" />;
    case "influencer_promo":
      return <Users className="w-4 h-4" />;
    default:
      return <FileText className="w-4 h-4" />;
  }
}

function StatCard({ title, value, icon: Icon, testId }: { 
  title: string; 
  value: number; 
  icon: typeof Clock;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold">{value}</p>
          </div>
          <div className="p-3 rounded-full bg-muted">
            <Icon className="w-6 h-6" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TaskCard({ task, onSelect }: { task: FulfillmentTask; onSelect: () => void }) {
  const statusInfo = statusLabels[task.status] || statusLabels.pending;
  
  return (
    <Card 
      className="hover-elevate cursor-pointer"
      onClick={onSelect}
      data-testid={`task-card-${task.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1">
            <div className="p-2 rounded-lg bg-muted">
              <TaskIcon taskType={task.taskType} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="font-semibold truncate">
                  {taskTypeLabels[task.taskType] || task.taskType}
                </h4>
                {task.isPriority && (
                  <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {task.sourceType === "benefit" ? "Subscription Benefit" : "À La Carte Purchase"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {format(new Date(task.createdAt), "MMM d, yyyy 'at' h:mm a")}
              </p>
            </div>
          </div>
          <Badge variant={statusInfo.variant}>
            {statusInfo.label}
          </Badge>
        </div>
        {task.vendorNotes && (
          <div className="mt-3 p-3 bg-muted rounded-lg">
            <p className="text-sm text-muted-foreground line-clamp-2">{task.vendorNotes}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TaskDetailDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { toast } = useToast();
  const [scheduledDate, setScheduledDate] = useState<Date | undefined>();
  const [adminNotes, setAdminNotes] = useState("");
  const [newStatus, setNewStatus] = useState("");

  const { data: details, isLoading } = useQuery<TaskDetails>({
    queryKey: ["/api/admin/fulfillment-tasks", taskId],
    enabled: !!taskId,
  });

  const updateMutation = useMutation({
    mutationFn: async (updates: Record<string, any>) => {
      return apiRequest("PATCH", `/api/admin/fulfillment-tasks/${taskId}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fulfillment-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fulfillment-stats"] });
      toast({ title: "Task updated successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to update task", variant: "destructive" });
    },
  });

  const handleUpdate = () => {
    const updates: Record<string, any> = {};
    if (newStatus) updates.status = newStatus;
    if (scheduledDate) updates.scheduledDate = scheduledDate.toISOString();
    if (adminNotes) updates.adminNotes = adminNotes;
    
    if (Object.keys(updates).length > 0) {
      updateMutation.mutate(updates);
    }
  };

  if (isLoading || !details) {
    return (
      <DialogContent className="sm:max-w-lg">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </DialogContent>
    );
  }

  const { task, vendor, business, purchase, allowance } = details;
  const statusInfo = statusLabels[task.status] || statusLabels.pending;

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <TaskIcon taskType={task.taskType} />
          {taskTypeLabels[task.taskType] || task.taskType}
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
          {task.isPriority && (
            <Badge variant="secondary" className="gap-1">
              <Star className="w-3 h-3" /> Priority
            </Badge>
          )}
          <Badge variant="outline">
            {task.sourceType === "benefit" ? "Subscription" : "À La Carte"}
          </Badge>
        </div>

        <div className="grid gap-4 py-4">
          {vendor && (
            <div className="flex items-center gap-3">
              <User className="w-4 h-4 text-muted-foreground" />
              <div>
                <p className="font-medium">{vendor.name}</p>
                <p className="text-sm text-muted-foreground">{vendor.email}</p>
              </div>
            </div>
          )}

          {business && (
            <div className="flex items-center gap-3">
              <Building2 className="w-4 h-4 text-muted-foreground" />
              <div>
                <p className="font-medium">{business.name}</p>
                <p className="text-sm text-muted-foreground">{business.category}</p>
              </div>
            </div>
          )}

          {purchase && (
            <div className="flex items-center gap-3">
              <FileText className="w-4 h-4 text-muted-foreground" />
              <div>
                <p className="font-medium">
                  Paid: ${(purchase.finalPriceInCents / 100).toFixed(2)}
                </p>
                <p className="text-sm text-muted-foreground">Payment: {purchase.paymentStatus}</p>
              </div>
            </div>
          )}

          {task.vendorNotes && (
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-sm font-medium mb-1">Vendor Notes:</p>
              <p className="text-sm text-muted-foreground">{task.vendorNotes}</p>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Update Status</label>
            <Select value={newStatus} onValueChange={setNewStatus}>
              <SelectTrigger data-testid="select-status">
                <SelectValue placeholder="Select new status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(newStatus === "scheduled" || task.status === "scheduled") && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Schedule Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left font-normal" data-testid="button-schedule-date">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {scheduledDate ? format(scheduledDate, "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={scheduledDate}
                    onSelect={setScheduledDate}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Admin Notes</label>
            <Textarea
              placeholder="Add notes about this task..."
              value={adminNotes}
              onChange={(e) => setAdminNotes(e.target.value)}
              data-testid="input-admin-notes"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} data-testid="button-cancel">
            Cancel
          </Button>
          <Button 
            onClick={handleUpdate} 
            disabled={updateMutation.isPending}
            data-testid="button-update-task"
          >
            {updateMutation.isPending ? "Updating..." : "Update Task"}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

export default function AdminFulfillmentPage() {
  const [selectedTab, setSelectedTab] = useState("pending");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const { data: stats } = useQuery<FulfillmentStats>({
    queryKey: ["/api/admin/fulfillment-stats"],
  });

  const { data: tasksData, isLoading } = useQuery<{ tasks: FulfillmentTask[]; total: number }>({
    queryKey: ["/api/admin/fulfillment-tasks", { status: selectedTab === "all" ? undefined : selectedTab }],
  });

  const tasks = tasksData?.tasks || [];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <h1 className="text-xl font-bold">Fulfillment Dashboard</h1>
          </div>
        </div>
      </header>

      <main className="container py-8">
        <div className="grid gap-4 md:grid-cols-4 mb-8">
          <StatCard
            title="Pending"
            value={stats?.pending || 0}
            icon={Clock}
            testId="stat-pending"
          />
          <StatCard
            title="Scheduled"
            value={stats?.scheduled || 0}
            icon={CalendarIcon}
            testId="stat-scheduled"
          />
          <StatCard
            title="In Progress"
            value={stats?.inProgress || 0}
            icon={AlertCircle}
            testId="stat-in-progress"
          />
          <StatCard
            title="Completed"
            value={stats?.completed || 0}
            icon={CheckCircle}
            testId="stat-completed"
          />
        </div>

        <Tabs value={selectedTab} onValueChange={setSelectedTab}>
          <TabsList className="mb-6">
            <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
            <TabsTrigger value="pending" data-testid="tab-pending">Pending</TabsTrigger>
            <TabsTrigger value="scheduled" data-testid="tab-scheduled">Scheduled</TabsTrigger>
            <TabsTrigger value="in_progress" data-testid="tab-in-progress">In Progress</TabsTrigger>
            <TabsTrigger value="completed" data-testid="tab-completed">Completed</TabsTrigger>
          </TabsList>

          <TabsContent value={selectedTab}>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              </div>
            ) : tasks.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                    <CheckCircle className="w-6 h-6 text-muted-foreground" />
                  </div>
                  <h3 className="font-semibold mb-1">No tasks</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedTab === "pending" 
                      ? "No pending tasks to review"
                      : `No ${selectedTab.replace("_", " ")} tasks`}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {tasks.map((task) => (
                  <TaskCard 
                    key={task.id} 
                    task={task}
                    onSelect={() => setSelectedTaskId(task.id)}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <Dialog open={!!selectedTaskId} onOpenChange={(open) => !open && setSelectedTaskId(null)}>
        {selectedTaskId && (
          <TaskDetailDialog 
            taskId={selectedTaskId} 
            onClose={() => setSelectedTaskId(null)} 
          />
        )}
      </Dialog>
    </div>
  );
}
