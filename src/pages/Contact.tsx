import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2 } from "lucide-react";
import { z } from "zod";

const contactSchema = z.object({
  topic: z.enum(['account', 'payments', 'contest', 'technical', 'compliance', 'dsar']),
  subject: z.string().min(1, "Subject is required").max(200),
  message: z.string().min(10, "Message must be at least 10 characters").max(5000),
  email: z.string().email("Invalid email address").optional()
});

export default function Contact() {
  const [formData, setFormData] = useState({
    topic: '',
    subject: '',
    message: '',
    email: ''
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchUserData = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('email')
          .eq('id', user.id)
          .maybeSingle();
        
        if (profile) {
          setUserProfile(profile);
          setFormData(prev => ({ ...prev, email: profile.email }));
        }
      }
    };

    fetchUserData();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const validatedData = contactSchema.parse(formData);
      setSubmitting(true);

      const { data, error } = await supabase.functions.invoke('support-tickets', {
        method: 'POST',
        body: validatedData
      });

      if (error) throw error;

      setSubmitted(true);
      toast({
        title: "Ticket Submitted",
        description: `Ticket #${data.ticket.id.slice(0, 8)} created. We'll respond within 24 hours.`
      });

      // Reset form
      setFormData({
        topic: '',
        subject: '',
        message: '',
        email: userProfile?.email || ''
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast({
          title: "Validation Error",
          description: error.errors[0].message,
          variant: "destructive"
        });
      } else {
        toast({
          title: "Error",
          description: "Failed to submit ticket. Please try again.",
          variant: "destructive"
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      
      <main className="flex-1 container mx-auto px-4 py-8">
        <Breadcrumbs items={[{ label: 'Support', path: '/support/help-center' }, { label: 'Contact Us' }]} />
        
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="text-center">
            <h1 className="text-4xl font-bold mb-2">Contact Support</h1>
            <p className="text-muted-foreground">
              We typically respond within 24 hours
            </p>
          </div>

          {submitted && (
            <Alert className="border-success bg-success/10">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <AlertDescription className="text-success">
                Your support ticket has been submitted successfully!
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Submit a Support Ticket</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="email">Email Address</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder="your@email.com"
                    required
                    disabled={!!userProfile}
                  />
                </div>

                <div>
                  <Label htmlFor="topic">Topic</Label>
                  <Select value={formData.topic} onValueChange={(value) => setFormData({ ...formData, topic: value })}>
                    <SelectTrigger id="topic">
                      <SelectValue placeholder="Select a topic" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="account">Account</SelectItem>
                      <SelectItem value="payments">Payments</SelectItem>
                      <SelectItem value="contest">Contest</SelectItem>
                      <SelectItem value="technical">Technical</SelectItem>
                      <SelectItem value="compliance">Compliance/State</SelectItem>
                      <SelectItem value="dsar">Data Subject Request</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="subject">Subject</Label>
                  <Input
                    id="subject"
                    value={formData.subject}
                    onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                    placeholder="Brief description of your issue"
                    required
                    maxLength={200}
                  />
                </div>

                <div>
                  <Label htmlFor="message">Message</Label>
                  <Textarea
                    id="message"
                    value={formData.message}
                    onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                    placeholder="Please provide details about your issue..."
                    required
                    rows={6}
                    maxLength={5000}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {formData.message.length}/5000 characters
                  </p>
                </div>

                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? 'Submitting...' : 'Submit Ticket'}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Other Ways to Reach Us</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                For urgent issues, you can also reach us at:
              </p>
              <p className="text-sm">
                <strong>Email:</strong> <a href="mailto:rowfantasy@gmail.com" className="text-primary hover:underline">rowfantasy@gmail.com</a>
              </p>
              <p className="text-sm">
                <strong>Hours:</strong> Monday-Friday, 9am-5pm ET
              </p>
            </CardContent>
          </Card>
        </div>
      </main>

      <Footer />
    </div>
  );
}